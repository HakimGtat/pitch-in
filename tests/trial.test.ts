import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptTask } from "@/lib/adoption";
import { emptyBrief } from "@/lib/brief";
import { runChecks } from "@/lib/checks/run";
import type { Db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";
import { handlePrClosed } from "@/lib/merge";
import { linkPullRequest } from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { reopenTask } from "@/lib/review";
import { loadTrialReport } from "@/lib/trial";
import { postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

// The Trial panel, worked out from what the site records.

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeGitHub>;
let olive: Awaited<ReturnType<typeof insertUser>>;
let gus: Awaited<ReturnType<typeof insertUser>>;
let dev: Awaited<ReturnType<typeof insertUser>>;
let repoId: number;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
  olive = await insertUser(db, { handle: "olive" });
  gus = await insertUser(db, { handle: "gus", profile: "guided" });
  dev = await insertUser(db, { handle: "dev", profile: "developer" });
  const connected = await connectRepo(db, fake.gh, olive.id, 1);
  if (!connected.ok) throw new Error("not connected");
  repoId = connected.repoId;
});

async function task(kind: "code" | "other" = "code") {
  const p = await postTask(
    db,
    fake.gh,
    olive.id,
    { repoId },
    {
      title: "T",
      kind,
      sizeTier: "small",
      allowedPaths: ["src/**"],
      brief: {
        ...emptyBrief(),
        goal: "Do it.",
        files: ["src/a.ts"],
        output: kind === "other" ? "src/notes.md with a summary" : "",
        acceptance: ["All tests pass"],
        testCommand: kind === "other" ? "none" : "npm test",
        constraints: "None.",
      },
    },
    true,
  );
  if (!p.ok) throw new Error("not posted");
  return p.taskId;
}

async function prFor(taskId: number, author: string, number: number) {
  const body = `Task: PI-${taskId}\n\n## Summary\n- x\n\n## Acceptance criteria\n- [x] All tests pass -> CI\n\n## Where to look\n- x\n\n## How it was tested\nx\n\n## Not done or assumed\n- Nothing\n\n## Agent\nClaude`;
  fake.addPull("acme/site", { number, author, body, headSha: `h${number}` }, [{ path: "src/a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n x\n+y" }]);
  fake.setCi("acme/site", `h${number}`, [{ name: "test", conclusion: "success" }]);
  await linkPullRequest(db, { repoId, repoFullName: "acme/site", defaultBranch: "main", number, baseRef: "main", headSha: `h${number}`, authorHandle: author, body, draft: false });
  await runChecks(db, { gh: fake.gh, scanner: { scan: async () => [] } }, { repoId, prNumber: number });
}

describe("the Trial panel", () => {
  it("counts merges by who did them, kind and estimate, and the review wait", async () => {
    const a = await task("other");
    await adoptTask(db, gus.id, a);
    await prFor(a, "gus", 1);
    const readyAt = new Date(((await db.select().from(submissions))[0].checkResults as { readyAt: string }).readyAt);
    await handlePrClosed(db, { repoId, prNumber: 1, merged: true, mergedBy: "olive", mergeCommitSha: "m1" }, new Date(readyAt.getTime() + 10 * 60_000));

    const b = await task();
    await prFor(b, "olive", 2);
    await handlePrClosed(db, { repoId, prNumber: 2, merged: true, mergedBy: "olive", mergeCommitSha: "m2" });

    const r = await loadTrialReport(db);
    expect(r.merged).toMatchObject({ total: 2, byContributors: 1, byOwners: 1, byProfile: { developer: 0, guided: 1 }, byKind: { code: 1, other: 1 } });
    expect(Math.round(r.medianReadyToMergedMinutes!)).toBe(10);
    expect(r.targets.find((t) => t.label.startsWith("At least 1 of them not code"))?.met).toBe(true);
    expect(r.targets.find((t) => t.label.startsWith("At least 5"))).toMatchObject({ value: "1", met: false });
    // The owner's own PR (PR 2) is left out of first-pass rates.
    expect(r.firstPass.find((f) => f.name === "CI")).toEqual({ name: "CI", passed: 1, of: 1 });
  });

  it("counts reopens by the profile of whoever held the task", async () => {
    const a = await task();
    await adoptTask(db, dev.id, a);
    await prFor(a, "dev", 3);
    await reopenTask(db, fake.gh, olive.id, a, { reason: "Off track.", developersOnly: false });
    const r = await loadTrialReport(db);
    expect(r.reopens).toEqual({ developer: 1, guided: 0 });
    expect(r.targets.find((t) => t.label === "Fewer than half of Developer PRs reopened")).toMatchObject({ value: "100%", met: false });
  });

  it("shows no data rather than zeroes it can't know", async () => {
    const r = await loadTrialReport(db);
    expect(r.medianReadyToMergedMinutes).toBeNull();
    expect(r.targets.find((t) => t.label.startsWith("Median wait"))).toMatchObject({ value: "no data yet", met: false });
    expect((await db.select().from(submissions).where(eq(submissions.id, 1))).length).toBe(0);
  });
});
