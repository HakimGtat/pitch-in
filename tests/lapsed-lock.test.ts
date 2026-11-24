import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptTask } from "@/lib/adoption";
import { emptyBrief } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { LOCK_HOURS } from "@/lib/lock";
import { linkPastedPr, linkPullRequest } from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { loadTaskView, loadUnlinkedForOwner } from "@/lib/views";
import { postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

// A run that started before the 48 hours ran out can open its PR after. Its
// part is done at the PR, so it must still link (Milestone 4 bug hunt).

const HOUR = 3600_000;
const t0 = new Date("2026-11-25T12:00:00Z");
const late = new Date(t0.getTime() + 50 * HOUR);

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
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
  const fake = fakeGitHub();
  fake.addRepo(1, "acme/site", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
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

describe("a PR that opens after its author's 48 hours ran out", () => {
  it("still links when nobody else took the task, and renews the hold", async () => {
    expect((await loadTaskView(db, taskId, late))?.holder).toBeNull();
    expect(await linkPullRequest(db, pr("alice"), late)).toMatchObject({ status: "linked", taskId });
    const view = await loadTaskView(db, taskId, late);
    expect(view?.holder?.handle).toBe("alice");
    expect(view?.holder?.expiresAt).toEqual(new Date(late.getTime() + LOCK_HOURS * HOUR));
  });

  it("doesn't link someone else's PR", async () => {
    expect(await linkPullRequest(db, pr("bob"), late)).toMatchObject({ status: "unlinked" });
  });

  it("doesn't link once someone else has taken the task", async () => {
    await adoptTask(db, bob.id, taskId, late);
    expect(await linkPullRequest(db, pr("alice"), late)).toMatchObject({ status: "unlinked" });
  });

  it("can be linked by the owner's paste, as the lapsed contributor's", async () => {
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/5", late);
    expect((await loadTaskView(db, taskId, late))?.holder?.handle).toBe("alice");
  });
});

describe("the owner's list of PRs that didn't link", () => {
  it("shows a PR that names their task, with the reason, until it links", async () => {
    await linkPullRequest(db, pr("bob", 9), t0);
    const list = await loadUnlinkedForOwner(db, olive.id, t0);
    expect(list).toEqual([
      { taskId, title: "A task", prNumber: 9, repoFullName: "acme/site", reason: `@alice took on PI-${taskId}, so only their PR links to it.` },
    ]);
    expect(await loadUnlinkedForOwner(db, bob.id, t0)).toEqual([]);
    await linkPastedPr(db, olive.id, taskId, "https://github.com/acme/site/pull/9", t0);
    expect(await loadUnlinkedForOwner(db, olive.id, t0)).toEqual([]);
  });
});
