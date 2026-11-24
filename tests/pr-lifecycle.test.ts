import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermissionError } from "@/lib/admin";
import { adoptTask, handBack } from "@/lib/adoption";
import { emptyBrief } from "@/lib/brief";
import { runChecks } from "@/lib/checks/run";
import type { Db } from "@/lib/db/client";
import { submissions, tasks } from "@/lib/db/schema";
import { handlePrClosed } from "@/lib/merge";
import { linkPastedPr, linkPullRequest, type PullRequestInfo } from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { reopenTask } from "@/lib/review";
import { loadTaskView } from "@/lib/views";
import { postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

// The PR lifecycle edge cases from the Milestone 4 bug hunt: PRs that close and
// come back, pasted links to PRs that aren't open, merges into other branches,
// a second PR for the same task, and pushes after a PR was ready for review.

const t0 = new Date("2026-11-25T12:00:00Z");
const noSecrets = { scan: async () => [] };

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeGitHub>;
let olive: Awaited<ReturnType<typeof insertUser>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let bob: Awaited<ReturnType<typeof insertUser>>;
let repoId: number;
let taskId: number;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin", bob: "write" });
  olive = await insertUser(db, { handle: "olive" });
  alice = await insertUser(db, { handle: "alice" });
  bob = await insertUser(db, { handle: "bob" });
  const connected = await connectRepo(db, fake.gh, olive.id, 1);
  if (!connected.ok) throw new Error("not connected");
  repoId = connected.repoId;
  const posted = await postTask(
    db,
    fake.gh,
    olive.id,
    { repoId },
    {
      title: "A task",
      kind: "code",
      sizeTier: "small",
      allowedPaths: ["src/**"],
      brief: { ...emptyBrief(), goal: "Do it.", files: ["src/a.ts"], acceptance: ["Works"], testCommand: "npm test", constraints: "None." },
    },
    true,
    t0,
  );
  if (!posted.ok) throw new Error("not posted");
  taskId = posted.taskId;
  await adoptTask(db, alice.id, taskId, t0);
});

const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  repoId,
  repoFullName: "acme/site",
  defaultBranch: "main",
  number: 5,
  baseRef: "main",
  headSha: "a1",
  authorHandle: "alice",
  body: `Task: PI-${taskId}`,
  draft: false,
  ...over,
});
const sub = async () => (await db.select().from(submissions))[0];
const taskStatus = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status;

describe("a PR that closes and comes back", () => {
  it("is checked again when it reopens, and its merge closes the task", async () => {
    await linkPullRequest(db, pr(), t0);
    await handlePrClosed(db, { repoId, prNumber: 5, merged: false, mergedBy: null, mergeCommitSha: null }, t0);
    expect((await sub()).status).toBe("closed");

    expect(await linkPullRequest(db, pr({ headSha: "a2" }), t0)).toMatchObject({ status: "linked", taskId });
    expect(await sub()).toMatchObject({ status: "checking", headSha: "a2" });

    expect(await handlePrClosed(db, { repoId, prNumber: 5, merged: true, mergedBy: "olive", mergeCommitSha: "m" }, t0)).toMatchObject({
      status: "merged",
    });
    expect(await taskStatus()).toBe("merged");
  });

  it("doesn't come back once the owner reopened the task for someone else", async () => {
    await linkPullRequest(db, pr(), t0);
    fake.addPull("acme/site", { number: 5, author: "alice" });
    await reopenTask(db, fake.gh, olive.id, taskId, { reason: "Off track.", developersOnly: false }, t0);
    await adoptTask(db, bob.id, taskId, t0);

    const out = await linkPullRequest(db, pr({ headSha: "a3" }), t0);
    expect(out).toMatchObject({ status: "unlinked", reason: expect.stringContaining("has moved on") });
    expect((await loadTaskView(db, taskId, t0))?.holder?.handle).toBe("bob");
  });
});

describe("a pasted link to a PR that isn't open", () => {
  it("stops holding the task when the PR doesn't exist", async () => {
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/404", t0);
    expect((await loadTaskView(db, taskId, t0))?.hasOpenPr).toBe(true);
    await runChecks(db, { gh: fake.gh, scanner: noSecrets }, { repoId, prNumber: 404 }, t0);
    expect((await sub()).status).toBe("closed");
    expect((await loadTaskView(db, taskId, t0))?.hasOpenPr).toBe(false);
    expect(await handBack(db, alice.id, taskId, t0)).toEqual([taskId]);
  });

  it("catches up with a PR that was already merged", async () => {
    fake.addPull("acme/site", { number: 6, author: "alice", state: "closed", merged: true, mergedBy: "olive", mergeCommitSha: "m6" });
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/6", t0);
    await runChecks(db, { gh: fake.gh, scanner: noSecrets }, { repoId, prNumber: 6 }, t0);
    expect((await sub()).status).toBe("merged");
    expect(await taskStatus()).toBe("merged");
  });

  it("isn't commented on or closed by a reopen", async () => {
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/404", t0);
    const out = await reopenTask(db, fake.gh, olive.id, taskId, { reason: "Wrong PR.", developersOnly: false }, t0);
    expect(out.closedPrs).toEqual([]);
    expect(fake.world.comments).toHaveLength(0);
    expect(await taskStatus()).toBe("open");
  });

  it("can be pasted again later, and links again", async () => {
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/404", t0);
    await runChecks(db, { gh: fake.gh, scanner: noSecrets }, { repoId, prNumber: 404 }, t0);
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/404", t0);
    expect((await sub()).status).toBe("checking");
  });
});

describe("other branches", () => {
  it("a merge into another branch doesn't finish the task", async () => {
    await linkPullRequest(db, pr(), t0);
    const out = await handlePrClosed(
      db,
      { repoId, prNumber: 5, merged: true, mergedBy: "olive", mergeCommitSha: "m", baseRef: "alice/feature", defaultBranch: "main" },
      t0,
    );
    expect(out).toEqual({ status: "closed", taskId });
    expect(await taskStatus()).toBe("adopted");
  });

  it("retargeting a linked PR away from the default branch unlinks it from review", async () => {
    await linkPullRequest(db, pr(), t0);
    await db.update(submissions).set({ status: "in_review" });
    await db.update(tasks).set({ status: "in_review" }).where(eq(tasks.id, taskId));
    expect(await linkPullRequest(db, pr({ baseRef: "alice/feature" }), t0)).toEqual({ status: "ignored" });
    expect((await sub()).status).toBe("closed");
    expect(await taskStatus()).toBe("adopted");
    // ...and back again.
    expect(await linkPullRequest(db, pr(), t0)).toMatchObject({ status: "linked" });
    expect((await sub()).status).toBe("checking");
  });
});

describe("one task, one PR", () => {
  it("a second PR for the same task doesn't link, and says why", async () => {
    await linkPullRequest(db, pr(), t0);
    const out = await linkPullRequest(db, pr({ number: 9 }), t0);
    expect(out).toEqual({ status: "unlinked", reason: `PI-${taskId} already has an open PR (#5). One task, one PR.` });
    await expect(linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/9", t0)).rejects.toThrow(PermissionError);
  });
});

describe("a push after a PR was ready for review", () => {
  it("puts it back to checking until the new commit is checked", async () => {
    await linkPullRequest(db, pr(), t0);
    await db.update(submissions).set({ status: "in_review" });
    await db.update(tasks).set({ status: "in_review" }).where(eq(tasks.id, taskId));
    await linkPullRequest(db, pr({ headSha: "b2" }), t0);
    expect(await sub()).toMatchObject({ status: "checking", headSha: "b2" });
    expect(await taskStatus()).toBe("adopted");
  });
});
