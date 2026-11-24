import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptTask } from "@/lib/adoption";
import { canAdoptTask } from "@/lib/adoption-rules";
import { emptyBrief } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";
import { connectRepo } from "@/lib/repos";
import { loadOwnerQueue, loadTaskView, openSubmissionFor, prStatusFor } from "@/lib/views";
import { postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const t0 = new Date("2026-11-24T12:00:00Z");
const results = (failing: string[] = []) =>
  ["Template", "Size", "Scope", "Secrets", "CI", "Criteria", "Evidence"].map((name) => ({
    name,
    passed: !failing.includes(name),
    detail: failing.includes(name) ? `${name.toLowerCase()} problem` : "ok",
  }));

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let olive: Awaited<ReturnType<typeof insertUser>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let bob: Awaited<ReturnType<typeof insertUser>>;
let taskIds: number[];

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  const fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin", bob: "write" });
  olive = await insertUser(db, { handle: "olive" });
  alice = await insertUser(db, { handle: "alice" });
  bob = await insertUser(db, { handle: "bob" });
  const connected = await connectRepo(db, fake.gh, olive.id, 1);
  if (!connected.ok) throw new Error("not connected");
  taskIds = [];
  for (const [owner, title] of [
    [olive, "Failing one"],
    [olive, "Ready one"],
    [bob, "Bob's task"],
  ] as const) {
    const p = await postTask(
      db,
      fake.gh,
      owner.id,
      { repoId: connected.repoId },
      {
        title,
        kind: "code",
        sizeTier: "small",
        allowedPaths: ["src/**"],
        brief: { ...emptyBrief(), goal: "Do it.", files: ["src/a.ts"], acceptance: ["Works"], testCommand: "npm test", constraints: "None." },
      },
      true,
      t0,
    );
    if (!p.ok) throw new Error("not posted");
    await adoptTask(db, alice.id, p.taskId, t0);
    taskIds.push(p.taskId);
  }
  await db.insert(submissions).values([
    { taskId: taskIds[1], prNumber: 2, headSha: "b", authorId: alice.id, status: "in_review", checkResults: { results: results() } },
    { taskId: taskIds[0], prNumber: 1, headSha: "a", authorId: alice.id, status: "checks_failed", checkResults: { results: results(["Scope", "Evidence"]) } },
    { taskId: taskIds[2], prNumber: 3, headSha: "c", authorId: alice.id, status: "checks_failed", checkResults: { results: results(["Size"]) } },
  ]);
});

describe("the owner's pages", () => {
  it("list their tasks whose PRs failed checks, with each failing line, before the ones ready for review", async () => {
    const queue = await loadOwnerQueue(db, olive.id);
    expect(queue.map((q) => [q.taskId, q.status])).toEqual([
      [taskIds[0], "checks_failed"],
      [taskIds[1], "in_review"],
    ]);
    expect(queue[0].failing).toEqual(["Scope: scope problem", "Evidence: evidence problem"]);
    expect(queue[1].failing).toEqual([]);
  });

  it("don't list other people's tasks", async () => {
    expect((await loadOwnerQueue(db, bob.id)).map((q) => q.taskId)).toEqual([taskIds[2]]);
    expect(await loadOwnerQueue(db, alice.id)).toEqual([]);
  });
});

describe("a PR whose checks failed", () => {
  it("shows the owner each failing check line, a link to the PR and Reopen", async () => {
    const s = (await openSubmissionFor(db, taskIds[0]))!;
    const owner = prStatusFor("owner", s);
    expect(owner.failing).toEqual(["Scope: scope problem", "Evidence: evidence problem"]);
    expect(owner.actions).toEqual(["open_pr", "reopen"]);
    expect(owner.headline).toContain("reopen the task");
    expect(owner.headline).toContain("Nothing expires while you decide");
  });

  it("tells the adopter their part is done, with no button that asks them to act", async () => {
    const s = (await openSubmissionFor(db, taskIds[0]))!;
    const adopter = prStatusFor("adopter", s);
    expect(adopter.actions).toEqual([]);
    expect(adopter.headline).toBe("Your part is done. Some checks failed, and the owner handles that from here; nothing is needed from you.");
    expect(adopter.headline).not.toMatch(/\bfix\b|please|re-?run|update your/i);
  });

  it("gives a PR ready for review the Review action, for the owner only", async () => {
    const s = (await openSubmissionFor(db, taskIds[1]))!;
    expect(prStatusFor("owner", s).actions).toEqual(["open_pr", "review", "reopen"]);
    expect(prStatusFor("admin", s).actions).toEqual(["open_pr", "reopen"]);
    expect(prStatusFor("adopter", s).actions).toEqual([]);
    expect(prStatusFor("other", s)).toEqual({ headline: "A PR for this task is in review.", failing: [], actions: [] });
  });

  it("has no fix window: the task stays held while the owner decides, long past 48 hours", async () => {
    const weekLater = new Date(t0.getTime() + 7 * 24 * 3600_000);
    const view = await loadTaskView(db, taskIds[0], weekLater);
    expect(view?.holder?.handle).toBe("alice");
    expect(view?.hasOpenPr).toBe(true);
  });
});

describe("someone else looking at a task whose PR is open", () => {
  it("is told it's held while the PR is open, not that a lock will run out", async () => {
    const view = (await loadTaskView(db, taskIds[0], t0))!;
    const decision = canAdoptTask({ ...bob, profile: "developer" }, view, { projectOpen: true });
    expect(decision).toEqual({ ok: false, reason: "@alice has taken this on, and their PR is open." });
  });
});
