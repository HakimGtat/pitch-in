import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptTask, releaseAdoption } from "@/lib/adoption";
import { emptyBrief } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { milestones, questions, submissions } from "@/lib/db/schema";
import { linkPullRequest } from "@/lib/pr-link";
import { loadWaitingOnOwner, recordQuestion } from "@/lib/questions";
import { connectRepo } from "@/lib/repos";
import { loadOwnerQueue, loadTaskView } from "@/lib/views";
import { closeProject, closeTask, createProject, postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

// Owner actions that used to leave a contributor's PR behind (Milestone 4 bug hunt).

const t0 = new Date("2026-11-25T12:00:00Z");
let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let olive: Awaited<ReturnType<typeof insertUser>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let repoId: number;
let fake: ReturnType<typeof fakeGitHub>;

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
});

const draft = (title: string) => ({
  title,
  kind: "code" as const,
  sizeTier: "small" as const,
  allowedPaths: ["src/**"],
  brief: { ...emptyBrief(), goal: "Do it.", files: ["src/a.ts"], acceptance: ["Works"], testCommand: "npm test", constraints: "None." },
});

async function taskWithPrAndQuestion(target: { repoId: number } | { milestoneId: number } = { repoId }) {
  const posted = await postTask(db, fake.gh, olive.id, target, draft("A task"), true, t0);
  if (!posted.ok) throw new Error("not posted");
  await adoptTask(db, alice.id, posted.taskId, t0);
  await linkPullRequest(
    db,
    { repoId, repoFullName: "acme/site", defaultBranch: "main", number: 5, baseRef: "main", headSha: "a", authorHandle: "alice", body: `Task: PI-${posted.taskId}`, draft: true },
    t0,
  );
  await db.update(submissions).set({ status: "checks_failed" });
  await recordQuestion(db, { repoId, prNumber: 5, commentId: 1, body: "Question for owner: which one?", commenter: "alice" }, t0);
  return posted.taskId;
}

describe("releasing someone", () => {
  it("is refused while their PR is open, so nobody else can take the task and its credit", async () => {
    const taskId = await taskWithPrAndQuestion();
    await expect(releaseAdoption(db, olive.id, taskId, t0)).rejects.toThrow("Their PR is still open. Reopen the task instead");
    expect((await loadTaskView(db, taskId, t0))?.holder?.handle).toBe("alice");
  });
});

describe("closing a task or a project", () => {
  it("closes the task's PR record and answers its questions, so nothing lingers in the owner's lists", async () => {
    const taskId = await taskWithPrAndQuestion();
    expect(await loadOwnerQueue(db, olive.id)).toHaveLength(1);
    expect(await loadWaitingOnOwner(db, olive.id)).toHaveLength(1);
    await closeTask(db, olive.id, taskId, t0);
    expect((await db.select().from(submissions))[0].status).toBe("closed");
    expect((await db.select().from(questions))[0].answeredAt).not.toBeNull();
    expect(await loadOwnerQueue(db, olive.id)).toEqual([]);
    expect(await loadWaitingOnOwner(db, olive.id)).toEqual([]);
  });

  it("does the same for every task of a closed project", async () => {
    const project = await createProject(db, fake.gh, olive.id, repoId, { title: "P", goal: "G.", milestones: [{ title: "M", goal: "G." }] }, t0);
    if (!project.ok) throw new Error("no project");
    const [m] = await db.select().from(milestones);
    await taskWithPrAndQuestion({ milestoneId: m.id });
    await closeProject(db, olive.id, project.projectId, t0);
    expect((await db.select().from(submissions))[0].status).toBe("closed");
    expect(await loadWaitingOnOwner(db, olive.id)).toEqual([]);
  });
});
