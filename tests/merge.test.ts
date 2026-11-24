import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextTaskInMilestone } from "@/lib/adoption-rules";
import { adoptMilestone, adoptTask } from "@/lib/adoption";
import { emptyBrief, type BriefDraft } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { adoptions, auditLog, milestones, projects, submissions, tasks } from "@/lib/db/schema";
import { receiveWebhook } from "@/lib/github/webhook";
import { runNextJob } from "@/lib/jobs";
import { LOCK_HOURS } from "@/lib/lock";
import { handlePrClosed, helpedShip, renewLock } from "@/lib/merge";
import { linkPullRequest } from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { loadTaskView, loadTaskViews } from "@/lib/views";
import { createProject, postTask } from "@/lib/work";
import { createHandlers } from "@/worker/handlers";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const HOUR = 3600_000;
const t0 = new Date("2026-11-24T12:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * HOUR);
const draft = (title: string): BriefDraft => ({
  title,
  kind: "code",
  sizeTier: "small",
  allowedPaths: ["src/**"],
  brief: { ...emptyBrief(), goal: "Do it.", files: ["src/a.ts"], acceptance: ["Works"], testCommand: "npm test", constraints: "None." },
});

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeGitHub>;
let olive: Awaited<ReturnType<typeof insertUser>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let repoId: number;
let milestoneIds: number[];
let ids: number[];

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
  olive = await insertUser(db, { handle: "olive" });
  alice = await insertUser(db, { handle: "alice" });
  const connected = await connectRepo(db, fake.gh, olive.id, 1);
  if (!connected.ok) throw new Error("not connected");
  repoId = connected.repoId;
  const project = await createProject(
    db,
    fake.gh,
    olive.id,
    repoId,
    { title: "Site", goal: "A site.", milestones: [{ title: "First", goal: "Usable." }, { title: "Second", goal: "Polished." }] },
    t0,
  );
  if (!project.ok) throw new Error("no project");
  milestoneIds = (await db.select().from(milestones).orderBy(milestones.position)).map((m) => m.id);
  ids = [];
  for (const [m, title] of [
    [0, "One"],
    [0, "Two"],
    [1, "Three"],
  ] as const) {
    const p = await postTask(db, fake.gh, olive.id, { milestoneId: milestoneIds[m] }, draft(title), true, t0);
    if (!p.ok) throw new Error("not posted");
    ids.push(p.taskId);
  }
});

async function linkPr(taskId: number, number: number, now: Date) {
  const out = await linkPullRequest(
    db,
    { repoId, repoFullName: "acme/site", defaultBranch: "main", number, baseRef: "main", headSha: `sha${number}`, authorHandle: "alice", body: `Task: PI-${taskId}`, draft: false },
    now,
  );
  if (out.status !== "linked") throw new Error("not linked");
  await db.update(tasks).set({ status: "in_review" }).where(eq(tasks.id, taskId));
}

const merge = (number: number, now: Date, merged = true) =>
  handlePrClosed(db, { repoId, prNumber: number, merged, mergedBy: "olive", mergeCommitSha: `m${number}` }, now);

describe("a merged PR", () => {
  it("sets the task to done and the adoption to completed", async () => {
    await adoptTask(db, alice.id, ids[0], t0);
    await linkPr(ids[0], 5, at(1));
    const out = await merge(5, at(2));
    expect(out).toMatchObject({ status: "merged", taskId: ids[0] });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, ids[0]));
    expect(task.status).toBe("merged");
    expect((await db.select().from(adoptions))[0].status).toBe("completed");
    expect((await db.select().from(submissions))[0].status).toBe("merged");
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "task.merged"))).toHaveLength(1);
  });

  it("opens the milestone's next task", async () => {
    await adoptTask(db, alice.id, ids[0], t0);
    await linkPr(ids[0], 5, at(1));
    let views = await loadTaskViews(db, eq(tasks.milestoneId, milestoneIds[0]), at(1));
    expect(nextTaskInMilestone(views)?.id).toBe(ids[0]);
    const out = await merge(5, at(2));
    expect(out).toMatchObject({ nextTaskId: ids[1], milestoneDone: false });
    views = await loadTaskViews(db, eq(tasks.milestoneId, milestoneIds[0]), at(2));
    expect(nextTaskInMilestone(views)?.id).toBe(ids[1]);
    expect((await loadTaskView(db, ids[1], at(2)))?.status).toBe("open");
  });

  it("finishes the milestone with its last task, and the project with its last milestone", async () => {
    await adoptMilestone(db, alice.id, milestoneIds[0], t0);
    await linkPr(ids[0], 5, at(1));
    await merge(5, at(2));
    await linkPr(ids[1], 6, at(3));
    expect(await merge(6, at(4))).toMatchObject({ milestoneDone: true, projectDone: false });
    expect((await db.select().from(milestones).where(eq(milestones.id, milestoneIds[0])))[0].status).toBe("done");

    await adoptTask(db, alice.id, ids[2], at(5));
    await linkPr(ids[2], 7, at(6));
    expect(await merge(7, at(7))).toMatchObject({ milestoneDone: true, projectDone: true });
    expect((await db.select().from(projects))[0].status).toBe("done");
  });

  it("gives the contributor a 'helped ship' entry", async () => {
    await adoptTask(db, alice.id, ids[0], t0);
    await linkPr(ids[0], 5, at(1));
    expect(await helpedShip(db, alice.id)).toEqual({ count: 0, tasks: [] });
    await merge(5, at(2));
    const shipped = await helpedShip(db, alice.id);
    expect(shipped.count).toBe(1);
    expect(shipped.tasks[0]).toMatchObject({ id: ids[0], title: "One", repoFullName: "acme/site" });
    expect((await helpedShip(db, olive.id)).count).toBe(0);
  });

  it("changes nothing the second time the same webhook arrives", async () => {
    await adoptTask(db, alice.id, ids[0], t0);
    await linkPr(ids[0], 5, at(1));
    await merge(5, at(2));
    expect(await merge(5, at(3))).toEqual({ status: "already_done" });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "task.merged"))).toHaveLength(1);
    expect((await helpedShip(db, alice.id)).count).toBe(1);
  });
});

describe("a PR closed without a merge", () => {
  it("doesn't close the task: it stays with its adopter", async () => {
    await adoptTask(db, alice.id, ids[0], t0);
    await linkPr(ids[0], 5, at(1));
    expect(await merge(5, at(2), false)).toEqual({ status: "closed", taskId: ids[0] });
    const view = await loadTaskView(db, ids[0], at(2));
    expect(view?.status).toBe("adopted");
    expect(view?.holder?.handle).toBe("alice");
    expect((await db.select().from(submissions))[0].status).toBe("closed");
    expect(await helpedShip(db, alice.id)).toEqual({ count: 0, tasks: [] });
  });

  it("isn't linked when it was never a Pitch In PR", async () => {
    expect(await merge(99, at(1))).toEqual({ status: "not_linked" });
  });
});

describe("the milestone lock", () => {
  it("renews on each of the adopter's PRs, for every task they hold in the milestone", async () => {
    await adoptMilestone(db, alice.id, milestoneIds[0], t0);
    await linkPr(ids[0], 5, at(40));
    expect(await renewLock(db, ids[0], at(40))).toBe(2);
    for (const a of await db.select().from(adoptions)) expect(a.expiresAt).toEqual(at(40 + LOCK_HOURS));

    await merge(5, at(50));
    const [second] = await db.select().from(adoptions).where(eq(adoptions.taskId, ids[1]));
    expect(second).toMatchObject({ status: "active", expiresAt: at(50 + LOCK_HOURS) });
    // Past the first 48 hours, the second task is still Alice's.
    expect((await loadTaskView(db, ids[1], at(60)))?.holder?.handle).toBe("alice");
  });

  it("renews from the PR webhook too", async () => {
    await adoptMilestone(db, alice.id, milestoneIds[0], t0);
    const secret = "test-webhook-secret";
    const body = JSON.stringify({
      action: "opened",
      repository: { id: 1, full_name: "acme/site", default_branch: "main" },
      pull_request: { number: 8, draft: false, body: `Task: PI-${ids[0]}`, user: { login: "alice" }, base: { ref: "main" }, head: { sha: "s8" } },
    });
    const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    await receiveWebhook(db, { secret, rawBody: body, event: "pull_request", deliveryId: "r1", signature: sig });
    const before = (await db.select().from(adoptions))[0].expiresAt;
    await runNextJob(db, createHandlers({ repoGitHub: () => fake.gh, scanner: () => ({ scan: async () => [] }) }), { info: () => {}, error: () => {} });
    const after = (await db.select().from(adoptions))[0].expiresAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
