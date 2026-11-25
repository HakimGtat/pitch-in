import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptTask } from "@/lib/adoption";
import { emptyBrief } from "@/lib/brief";
import { SITE_CHECK_NAME } from "@/lib/checks/types";
import type { Db } from "@/lib/db/client";
import { jobs, submissions, tasks } from "@/lib/db/schema";
import { runNextJob } from "@/lib/jobs";
import { linkPullRequest } from "@/lib/pr-link";
import { openQuestionsFor } from "@/lib/questions";
import { connectRepo } from "@/lib/repos";
import { queueSweep, runSweep, SWEEP_EVERY_MS, SWEEP_JOB } from "@/lib/sweep";
import { postTask } from "@/lib/work";
import { createHandlers } from "@/worker/handlers";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

// The catch-up sweep: what smee dropped while the machine was off still happens.

const quiet = { info: () => {}, error: () => {} };
let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeGitHub>;
let repoId: number;
let taskId: number;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
  const olive = await insertUser(db, { handle: "olive" });
  const alice = await insertUser(db, { handle: "alice" });
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
  );
  if (!posted.ok) throw new Error("not posted");
  taskId = posted.taskId;
  await adoptTask(db, alice.id, taskId);
});

const runAll = async () => {
  const handlers = createHandlers({ repoGitHub: () => fake.gh, scanner: () => ({ scan: async () => [] }) });
  while (await runNextJob(db, handlers, quiet)) {
    /* run what's ready */
  }
};
const link = () =>
  linkPullRequest(db, { repoId, repoFullName: "acme/site", defaultBranch: "main", number: 5, baseRef: "main", headSha: "h1", authorHandle: "alice", body: `Task: PI-${taskId}`, draft: false });

describe("the catch-up sweep", () => {
  it("catches a merge whose webhook never arrived", async () => {
    await link();
    fake.addPull("acme/site", { number: 5, author: "alice", body: `Task: PI-${taskId}`, headSha: "h1", state: "closed", merged: true, mergedBy: "olive", mergeCommitSha: "m5" });
    expect(await runSweep(db, fake.gh)).toMatchObject({ queued: 1 });
    await runAll();
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status).toBe("merged");
  });

  it("checks a PR whose opened webhook never arrived", async () => {
    fake.addPull("acme/site", { number: 7, author: "alice", body: `Task: PI-${taskId}`, headSha: "h7" });
    fake.setCi("acme/site", "h7", [{ name: "test", conclusion: "success" }]);
    expect(await runSweep(db, fake.gh)).toMatchObject({ queued: 1 });
    await runAll();
    expect((await db.select().from(submissions))[0]).toMatchObject({ prNumber: 7, headSha: "h7" });
    expect(fake.world.posted.filter((p) => p.name === SITE_CHECK_NAME)).toHaveLength(1);
  });

  it("picks up a question whose webhook never arrived", async () => {
    await link();
    fake.addPull("acme/site", { number: 5, author: "alice", body: `Task: PI-${taskId}`, headSha: "h1" });
    fake.world.comments.push({ fullName: "acme/site", number: 5, body: "Question for owner: A or B?", id: 31, author: "alice" });
    expect(await runSweep(db, fake.gh)).toMatchObject({ queued: 0, questions: 1 });
    expect(await openQuestionsFor(db, taskId)).toHaveLength(1);
  });

  it("does nothing when nothing changed", async () => {
    await link();
    fake.addPull("acme/site", { number: 5, author: "alice", body: `Task: PI-${taskId}`, headSha: "h1" });
    fake.addPull("acme/site", { number: 8, author: "bob", body: "Fix a typo", headSha: "h8" });
    expect(await runSweep(db, fake.gh)).toEqual({ looked: 1, queued: 0, questions: 0, skippedRepos: 0, errors: 0 });
  });

  it("runs every five minutes, one job per slot, and the next is queued after each", async () => {
    const t = new Date("2026-11-25T12:01:00Z");
    await queueSweep(db, t);
    await queueSweep(db, t);
    const queued = await db.select().from(jobs).where(eq(jobs.type, SWEEP_JOB));
    expect(queued).toHaveLength(1);
    expect(queued[0].runAfter.getTime() % SWEEP_EVERY_MS).toBe(0);
    await runNextJob(db, createHandlers({ repoGitHub: () => fake.gh }), quiet, new Date(queued[0].runAfter.getTime() + 1000));
    expect((await db.select().from(jobs).where(eq(jobs.type, SWEEP_JOB))).filter((j) => j.status === "queued")).toHaveLength(1);
  });
});

describe("the sweep when GitHub misbehaves", () => {
  it("skips a repo the App can't see instead of unlinking its PRs", async () => {
    await link();
    fake.world.repos.delete(1);
    expect(await runSweep(db, fake.gh)).toMatchObject({ skippedRepos: 1, queued: 0 });
    await runAll();
    expect((await db.select().from(submissions))[0].status).toBe("checking");
  });

  it("keeps going past a PR GitHub errors on", async () => {
    await link();
    const real = fake.gh.getPullRequest;
    fake.gh.getPullRequest = async () => {
      throw new Error("GitHub had a moment");
    };
    fake.addPull("acme/site", { number: 9, author: "alice", body: `Task: PI-${taskId}`, headSha: "h9" });
    const r = await runSweep(db, fake.gh);
    fake.gh.getPullRequest = real;
    expect(r).toMatchObject({ errors: 1 });
    expect(r.looked).toBeGreaterThanOrEqual(1);
  });

  it("checks again a PR stuck at checking, and one whose description changed", async () => {
    await link();
    fake.addPull("acme/site", { number: 5, author: "alice", body: `Task: PI-${taskId}`, headSha: "h1" });
    const later = new Date(Date.now() + 20 * 60_000);
    expect(await runSweep(db, fake.gh, later)).toMatchObject({ queued: 1 });

    await db.update(submissions).set({ status: "in_review", checkResults: { pr: { body: `Task: PI-${taskId}` }, results: [] } });
    fake.world.pulls.get("acme/site#5")!.body = `Task: PI-${taskId}\n\n## Question for owner\nA or B?`;
    expect(await runSweep(db, fake.gh)).toMatchObject({ queued: 1 });
  });

  it("re-checks failed CI for an hour after the run, then leaves it until something changes", async () => {
    await link();
    fake.addPull("acme/site", { number: 5, author: "alice", body: `Task: PI-${taskId}`, headSha: "h1" });
    const ranAt = new Date("2026-11-25T12:00:00Z");
    await db.update(submissions).set({
      status: "checks_failed",
      updatedAt: ranAt,
      checkResults: { ranAt: ranAt.toISOString(), pr: { body: `Task: PI-${taskId}` }, results: [{ name: "CI", passed: false, detail: "test failed" }] },
    });
    expect(await runSweep(db, fake.gh, new Date(ranAt.getTime() + 30 * 60_000))).toMatchObject({ queued: 1 });
    await db.delete(jobs);
    expect(await runSweep(db, fake.gh, new Date(ranAt.getTime() + 2 * 3600_000))).toMatchObject({ queued: 0 });
  });
});
