import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermissionError } from "@/lib/admin";
import { adoptTask } from "@/lib/adoption";
import { checkMerge, checkPush, describeAlert, listOpenAlerts, openAlertsForTask, PUSH_CHECK_DELAY_MS, resolveAlert } from "@/lib/alerts";
import { emptyBrief } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { alerts, auditLog, repos, type Repo } from "@/lib/db/schema";
import { receiveWebhook } from "@/lib/github/webhook";
import { runNextJob } from "@/lib/jobs";
import { linkPullRequest } from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { postTask } from "@/lib/work";
import { createHandlers } from "@/worker/handlers";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeGitHub>;
let repo: Repo;
let taskId: number;
let root: Awaited<ReturnType<typeof insertUser>>;
let olive: Awaited<ReturnType<typeof insertUser>>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  fake = fakeGitHub();
  // olive owns the task and can write; root is a repo admin; mallory can write but isn't the owner.
  fake.addRepo(42, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, {
    olive: "write",
    root: "admin",
    mallory: "write",
  });
  root = await insertUser(db, { handle: "root", isMainAdmin: true });
  olive = await insertUser(db, { handle: "olive" });
  const alice = await insertUser(db, { handle: "alice" });
  const connected = await connectRepo(db, fake.gh, root.id, 42);
  if (!connected.ok) throw new Error("not connected");
  [repo] = await db.select().from(repos).where(eq(repos.id, connected.repoId));
  const posted = await postTask(
    db,
    fake.gh,
    olive.id,
    { repoId: repo.id },
    {
      title: "Reject empty uploads",
      kind: "code",
      sizeTier: "small",
      allowedPaths: ["src/**"],
      brief: { ...emptyBrief(), goal: "Reject empty files.", files: ["src/a.ts"], acceptance: ["Works"], testCommand: "npm test", constraints: "None." },
    },
    true,
  );
  if (!posted.ok) throw new Error("not posted");
  taskId = posted.taskId;
  await adoptTask(db, alice.id, taskId);
  await linkPullRequest(db, { repoId: repo.id, repoFullName: "acme/site", defaultBranch: "main", number: 7, baseRef: "main", headSha: "h7", authorHandle: "alice", body: `Task: PI-${taskId}`, draft: false });
});

const merged = (number: number, mergedBy: string, sha: string) =>
  fake.addPull("acme/site", { number, author: "alice", state: "closed", merged: true, mergedBy, mergeCommitSha: sha });

describe("a merge of a linked PR", () => {
  it("by the task owner raises no alert", async () => {
    expect(await checkMerge(db, fake.gh, { repo, prNumber: 7, mergedBy: "olive", mergeCommitSha: "m1" })).toBe("reviewed");
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it("by a repo admin raises no alert", async () => {
    expect(await checkMerge(db, fake.gh, { repo, prNumber: 7, mergedBy: "root", mergeCommitSha: "m1" })).toBe("reviewed");
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it("by anyone else creates an unreviewed_merge alert, an audit_log row and a warning on the task page", async () => {
    expect(await checkMerge(db, fake.gh, { repo, prNumber: 7, mergedBy: "mallory", mergeCommitSha: "m1" })).toBe("alert");
    const [alert] = await db.select().from(alerts);
    expect(alert).toMatchObject({ kind: "unreviewed_merge", details: { pr: 7, taskId, mergedBy: "mallory", owner: "olive" } });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "alert.unreviewed_merge"))).toHaveLength(1);
    const onTask = await openAlertsForTask(db, taskId);
    expect(onTask).toHaveLength(1);
    expect(describeAlert(onTask[0])).toBe(`PR #7 (PI-${taskId}) in acme/site was merged by @mallory, not the task owner @olive or a repo admin.`);
  });

  it("raises the alert once, even when GitHub repeats itself", async () => {
    await checkMerge(db, fake.gh, { repo, prNumber: 7, mergedBy: "mallory", mergeCommitSha: "m1" });
    await checkMerge(db, fake.gh, { repo, prNumber: 7, mergedBy: "mallory", mergeCommitSha: "m1" });
    expect(await db.select().from(alerts)).toHaveLength(1);
  });
});

describe("a push to the default branch", () => {
  const push = (after: string, pusher = "mallory") => ({ repoId: repo.id, after, before: "b0", pusher, forced: false });

  it("with no owner-merged PR creates a direct_push alert", async () => {
    expect(await checkPush(db, fake.gh, push("d1"))).toBe("alert");
    const [alert] = await db.select().from(alerts);
    expect(alert).toMatchObject({ kind: "direct_push", details: { sha: "d1", pusher: "mallory" } });
    expect(describeAlert({ ...alert, repoFullName: "acme/site", details: alert.details as Record<string, unknown> })).toBe(
      "acme/site's default branch moved to d1 without an owner-merged PR (pushed by @mallory).",
    );
  });

  it("that comes from an owner-merged PR creates no alert", async () => {
    merged(7, "olive", "m7");
    expect(await checkPush(db, fake.gh, push("m7", "olive"))).toBe("reviewed");
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it("that comes from a PR a repo admin merged creates no alert, linked or not", async () => {
    merged(30, "root", "m30");
    expect(await checkPush(db, fake.gh, push("m30", "root"))).toBe("reviewed");
    expect(await db.select().from(alerts)).toHaveLength(0);
  });

  it("from a linked PR the wrong person merged gives one unreviewed_merge alert, not a second one", async () => {
    merged(7, "mallory", "m7");
    expect(await checkPush(db, fake.gh, push("m7"))).toBe("alerted_on_merge");
    await checkMerge(db, fake.gh, { repo, prNumber: 7, mergedBy: "mallory", mergeCommitSha: "m7" });
    expect((await db.select().from(alerts)).map((a) => a.kind)).toEqual(["unreviewed_merge"]);
  });

  it("from an unlinked PR merged by someone who isn't a repo admin is a direct push", async () => {
    merged(31, "mallory", "m31");
    expect(await checkPush(db, fake.gh, push("m31"))).toBe("alert");
    expect((await db.select().from(alerts))[0]).toMatchObject({ kind: "direct_push", details: { pr: 31, mergedBy: "mallory" } });
  });

  it("is checked shortly after the push webhook, by its own job", async () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({
      ref: "refs/heads/main",
      before: "b0",
      after: "d9",
      forced: true,
      repository: { id: 42, full_name: "acme/site", default_branch: "main" },
      sender: { login: "mallory" },
    });
    const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    await receiveWebhook(db, { secret, rawBody: body, event: "push", deliveryId: "p1", signature: sig });
    const handlers = createHandlers({ repoGitHub: () => fake.gh, scanner: () => ({ scan: async () => [] }) });
    const quiet = { info: () => {}, error: () => {} };
    while (await runNextJob(db, handlers, quiet)) {
      /* the webhook job; the check waits */
    }
    expect(await db.select().from(alerts)).toHaveLength(0);
    await runNextJob(db, handlers, quiet, new Date(Date.now() + PUSH_CHECK_DELAY_MS + 1000));
    expect((await db.select().from(alerts))[0]).toMatchObject({ kind: "direct_push", details: { sha: "d9", pusher: "mallory", forced: true } });
  });
});

describe("the admin page", () => {
  it("lists open alerts and lets the main admin resolve one", async () => {
    await checkPush(db, fake.gh, { repoId: repo.id, after: "d1", before: "b0", pusher: "mallory", forced: false });
    const [open] = await listOpenAlerts(db);
    expect(open).toMatchObject({ kind: "direct_push", repoFullName: "acme/site" });

    await expect(resolveAlert(db, olive.id, open.id)).rejects.toThrow(PermissionError);
    await resolveAlert(db, root.id, open.id);
    expect(await listOpenAlerts(db)).toEqual([]);
    expect((await db.select().from(alerts))[0].resolvedById).toBe(root.id);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "alert.resolved"))).toHaveLength(1);
    await expect(resolveAlert(db, root.id, open.id)).rejects.toThrow("already resolved");
  });
});

describe("a forced push", () => {
  it("raises a direct_push alert even when it lands on an owner-merged commit", async () => {
    merged(7, "olive", "m7");
    expect(await checkPush(db, fake.gh, { repoId: repo.id, after: "m7", before: "newer", pusher: "olive", forced: true })).toBe("alert");
    expect((await db.select().from(alerts))[0]).toMatchObject({ kind: "direct_push", details: { sha: "m7", forced: true } });
  });
});

describe("a push by a repo admin", () => {
  it("is logged, not alerted, unless it's forced", async () => {
    expect(await checkPush(db, fake.gh, { repoId: repo.id, after: "a1", before: "b0", pusher: "root", forced: false })).toBe("admin_push");
    expect(await db.select().from(alerts)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "push.by_admin"))).toHaveLength(1);
    expect(await checkPush(db, fake.gh, { repoId: repo.id, after: "a2", before: "a1", pusher: "root", forced: true })).toBe("alert");
  });
});
