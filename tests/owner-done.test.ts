import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermissionError } from "@/lib/admin";
import { adoptTask } from "@/lib/adoption";
import { canAdoptTask } from "@/lib/adoption-rules";
import { emptyBrief } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { auditLog, submissions, tasks } from "@/lib/db/schema";
import { handlePrClosed, helpedShip } from "@/lib/merge";
import { linkPastedPr, linkPullRequest } from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { loadTaskView } from "@/lib/views";
import { postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

// An owner doing their own task: their PR links as owner-done and its merge
// closes the task, with no "helped ship" credit. This replaces mark-merged.

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let olive: Awaited<ReturnType<typeof insertUser>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let repoId: number;
let taskId: number;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  const fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
  olive = await insertUser(db, { handle: "olive" });
  alice = await insertUser(db, { handle: "alice" });
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
});

const pr = (author: string, number = 5) => ({
  repoId,
  repoFullName: "acme/site",
  defaultBranch: "main",
  number,
  baseRef: "main",
  headSha: "a",
  authorHandle: author,
  body: `Task: PI-${taskId}`,
  draft: false,
});

describe("the owner's own PR for their own task", () => {
  it("links as owner-done when nobody holds the task, and its merge closes the task with no helped-ship credit", async () => {
    expect(await linkPullRequest(db, pr("olive"))).toMatchObject({ status: "linked", taskId });
    expect((await db.select().from(submissions))[0].authorId).toBe(olive.id);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "pr.linked"));
    expect(entry.details).toMatchObject({ how: "owner's own PR" });

    expect(await handlePrClosed(db, { repoId, prNumber: 5, merged: true, mergedBy: "olive", mergeCommitSha: "m" })).toMatchObject({ status: "merged" });
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status).toBe("merged");
    expect((await helpedShip(db, olive.id)).count).toBe(0);
  });

  it("keeps anyone else from taking the task on while it's open", async () => {
    await linkPullRequest(db, pr("olive"));
    const view = (await loadTaskView(db, taskId, new Date()))!;
    expect(canAdoptTask({ ...alice, profile: "developer" }, view, { projectOpen: true })).toEqual({
      ok: false,
      reason: "The owner has a PR open for this task.",
    });
    await expect(adoptTask(db, alice.id, taskId)).rejects.toThrow(PermissionError);
  });

  it("doesn't link when someone else has taken the task on", async () => {
    await adoptTask(db, alice.id, taskId);
    expect(await linkPullRequest(db, pr("olive"))).toMatchObject({ status: "unlinked" });
  });

  it("can be pasted by the owner", async () => {
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/12");
    expect((await db.select().from(submissions))[0]).toMatchObject({ prNumber: 12, authorId: olive.id });
  });
});
