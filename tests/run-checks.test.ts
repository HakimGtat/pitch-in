import { createHmac } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptTask } from "@/lib/adoption";
import { emptyBrief } from "@/lib/brief";
import { CHECKS_JOB, checksJobKey, queueChecks, runChecks, type StoredChecks } from "@/lib/checks/run";
import type { SecretScanner } from "@/lib/checks/secrets";
import { SITE_CHECK_NAME } from "@/lib/checks/types";
import type { Db } from "@/lib/db/client";
import { jobs, submissions, tasks } from "@/lib/db/schema";
import { receiveWebhook } from "@/lib/github/webhook";
import { runNextJob } from "@/lib/jobs";
import { connectRepo } from "@/lib/repos";
import { postTask } from "@/lib/work";
import { createHandlers } from "@/worker/handlers";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const secret = "test-webhook-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
const quiet = { info: () => {}, error: () => {} };
const noSecrets: SecretScanner = { scan: async () => [] };

const CRITERIA = ["Empty files get a 400 error", "A test covers the empty file", "All existing tests pass"];
const PATCH = "@@ -1,2 +1,5 @@\n def upload(f):\n+    if f.size == 0:\n+        raise BadRequest()\n+    # done\n     return save(f)";
const TEST_PATCH = "@@ -0,0 +1,2 @@\n+def test_empty():\n+    assert upload(empty).status == 400";

const goodBody = (id: number, over: { criteria?: string[] } = {}) =>
  [
    `Task: PI-${id}`,
    "",
    "## Summary",
    "- Empty uploads are rejected",
    "",
    "## Acceptance criteria",
    ...(over.criteria ?? [
      "- [x] Empty files get a 400 error -> src/upload.py:2-3",
      "- [x] A test covers the empty file -> tests/test_upload.py:1",
      "- [x] All existing tests pass -> CI",
    ]),
    "",
    "## Where to look",
    "- src/upload.py:2-3: the new check",
    "",
    "## How it was tested",
    "`pytest` -> 12 passed",
    "Second review pass: nothing new",
    "",
    "## Not done or assumed",
    "- Nothing",
    "",
    "## Agent",
    "Claude Code, Claude Sonnet 5.5",
  ].join("\n");

const goodFiles = [
  { path: "src/upload.py", additions: 3, deletions: 0, patch: PATCH },
  { path: "tests/test_upload.py", additions: 2, deletions: 0, patch: TEST_PATCH },
];

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeGitHub>;
let taskId: number;
let repoId: number;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  fake = fakeGitHub();
  fake.addRepo(42, "acme/uploader", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/upload.py": "x" }, { olive: "admin" });
  const olive = await insertUser(db, { handle: "olive" });
  const alice = await insertUser(db, { handle: "alice" });
  await insertUser(db, { handle: "bob" });
  const connected = await connectRepo(db, fake.gh, olive.id, 42);
  if (!connected.ok) throw new Error("not connected");
  repoId = connected.repoId;
  const posted = await postTask(
    db,
    fake.gh,
    olive.id,
    { repoId },
    {
      title: "Reject empty uploads",
      kind: "code",
      sizeTier: "small",
      allowedPaths: ["src/**", "tests/**"],
      brief: { ...emptyBrief(), goal: "Reject empty files.", files: ["src/upload.py"], acceptance: CRITERIA, testCommand: "pytest", constraints: "None." },
    },
    true,
  );
  if (!posted.ok) throw new Error("not posted");
  taskId = posted.taskId;
  await adoptTask(db, alice.id, taskId);
});

const handlers = () => createHandlers({ repoGitHub: () => fake.gh, scanner: () => noSecrets });

/** Sends a pull_request webhook for the PR as it is in the fake, then runs every queued job. */
async function sendPr(number: number, action = "opened", delivery = `d-${number}-${action}-${Math.random()}`) {
  const pr = (await fake.gh.getPullRequest("acme/uploader", number))!;
  const body = JSON.stringify({
    action,
    repository: { id: 42, full_name: "acme/uploader", default_branch: "main" },
    pull_request: {
      number,
      draft: pr.draft,
      body: pr.body,
      user: { login: pr.author },
      base: { ref: pr.baseRef },
      head: { sha: pr.headSha },
    },
  });
  await receiveWebhook(db, { secret, rawBody: body, event: "pull_request", deliveryId: delivery, signature: sign(body) });
  while (await runNextJob(db, handlers(), quiet)) {
    /* run everything that's ready */
  }
}

const ours = () => fake.world.posted.filter((p) => p.name === SITE_CHECK_NAME);
const stored = async () => (await db.select().from(submissions))[0]?.checkResults as StoredChecks | undefined;

describe("running the checks on a linked PR", () => {
  it("posts one check run with seven result lines and the plan's summary", async () => {
    fake.addPull("acme/uploader", { number: 7, author: "alice", body: goodBody(taskId), headSha: "aaa" }, goodFiles);
    fake.setCi("acme/uploader", "aaa", [{ name: "test", conclusion: "success" }]);
    await sendPr(7);

    expect(ours()).toHaveLength(1);
    const run = ours()[0].run;
    expect(run.headSha).toBe("aaa");
    expect(run.status).toBe("completed");
    expect(run.conclusion).toBe("success");
    expect(run.summary.split("\n")[0]).toBe("Pitch In checks: 7 passed, 0 failed");
    const lines = run.summary.split("\n").filter((l) => /^[✓✗] /.test(l));
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("✓ Template   all sections filled");
    expect(lines[1]).toBe("✓ Size       5 of 300 lines");
    expect(lines[4]).toBe("✓ CI         test: success");

    const s = await stored();
    expect(s?.results.map((r) => r.name)).toEqual(["Template", "Size", "Scope", "Secrets", "CI", "Criteria", "Evidence"]);
    const [sub] = await db.select().from(submissions);
    expect(sub.status).toBe("in_review");
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status).toBe("in_review");
  });

  it("shows Size failing for an oversized PR and a dangling pointer as a warning", async () => {
    const big = [...goodFiles, { path: "src/big.py", additions: 400, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+x" }];
    const dangling = goodBody(taskId, {
      criteria: [
        "- [x] Empty files get a 400 error -> src/upload.py:1",
        "- [x] A test covers the empty file -> tests/test_upload.py:1",
        "- [x] All existing tests pass -> CI",
      ],
    });
    fake.addPull("acme/uploader", { number: 8, author: "alice", body: dangling, headSha: "bbb" }, big);
    fake.setCi("acme/uploader", "bbb", [{ name: "test", conclusion: "success" }]);
    await sendPr(8);

    const run = ours()[0].run;
    expect(run.conclusion).toBe("failure");
    expect(run.summary.split("\n")[0]).toBe("Pitch In checks: 5 passed, 1 failed, 1 warning");
    expect(run.summary).toContain("✗ Size       405 of 300 lines");
    expect(run.summary).toContain('⚠ Evidence   2 of 3 pointers found in the diff; "Empty files get a 400 error" points to src/upload.py:1, an unchanged line');
    expect((await db.select().from(submissions))[0].status).toBe("checks_failed");
  });

  it("checks a new push again, on the new head sha", async () => {
    fake.addPull("acme/uploader", { number: 9, author: "alice", body: goodBody(taskId), headSha: "c1" }, goodFiles);
    fake.setCi("acme/uploader", "c1", [{ name: "test", conclusion: "failure" }]);
    await sendPr(9);
    expect(ours()[0].run).toMatchObject({ headSha: "c1", conclusion: "failure" });

    fake.world.pulls.get("acme/uploader#9")!.headSha = "c2";
    fake.setCi("acme/uploader", "c2", [{ name: "test", conclusion: "success" }]);
    await sendPr(9, "synchronize");
    expect(ours()).toHaveLength(2);
    expect(ours()[1]).toMatchObject({ op: "create", run: { headSha: "c2", conclusion: "success" } });
    expect((await stored())?.headSha).toBe("c2");
  });

  it("updates the same check run when the PR body is edited on the same commit", async () => {
    fake.addPull("acme/uploader", { number: 10, author: "alice", body: goodBody(taskId).replace("## Agent\nClaude Code, Claude Sonnet 5.5", "## Agent\n"), headSha: "d1" }, goodFiles);
    fake.setCi("acme/uploader", "d1", [{ name: "test", conclusion: "success" }]);
    await sendPr(10);
    expect(ours()[0].run.conclusion).toBe("neutral");

    fake.world.pulls.get("acme/uploader#10")!.body = goodBody(taskId);
    await sendPr(10, "edited");
    expect(ours()).toHaveLength(2);
    expect(ours()[1]).toMatchObject({ op: "update", id: ours()[0].id, run: { conclusion: "success" } });
  });

  it("waits for CI that is still running, then checks again", async () => {
    fake.addPull("acme/uploader", { number: 11, author: "alice", body: goodBody(taskId), headSha: "e1" }, goodFiles);
    fake.setCi("acme/uploader", "e1", [{ name: "test", status: "in_progress", conclusion: null }]);
    await sendPr(11);
    expect(ours()[0].run).toMatchObject({ status: "in_progress", title: "6 passed, 1 failed, waiting for CI" });
    expect((await db.select().from(submissions))[0].status).toBe("checking");
    const waiting = await db.select().from(jobs).where(like(jobs.dedupeKey, `${checksJobKey({ repoId, prNumber: 11 }, "e1")}:wait@%`));
    expect(waiting).toHaveLength(1);

    fake.setCi("acme/uploader", "e1", [{ name: "test", conclusion: "success" }]);
    await runNextJob(db, handlers(), quiet, new Date(Date.now() + 2 * 60_000));
    expect(ours().at(-1)).toMatchObject({ op: "update", run: { status: "completed", conclusion: "success" } });
    expect((await db.select().from(submissions))[0].status).toBe("in_review");
  });

  it("checks again when the repo's CI suite completes, but not for its own check run", async () => {
    fake.addPull("acme/uploader", { number: 12, author: "alice", body: goodBody(taskId), headSha: "f1" }, goodFiles);
    fake.setCi("acme/uploader", "f1", [{ name: "test", conclusion: "failure" }]);
    await sendPr(12);
    const suite = (name: string) =>
      JSON.stringify({
        action: "completed",
        repository: { id: 42, full_name: "acme/uploader", default_branch: "main" },
        check_run: { name, head_sha: "f1", pull_requests: [{ number: 12 }] },
      });
    for (const [i, name] of [SITE_CHECK_NAME, "test"].entries()) {
      fake.setCi("acme/uploader", "f1", [{ name: "test", conclusion: "success" }]);
      const raw = suite(name);
      await receiveWebhook(db, { secret, rawBody: raw, event: "check_run", deliveryId: `cr-${i}`, signature: sign(raw) });
      while (await runNextJob(db, handlers(), quiet)) {
        /* run */
      }
      expect(ours()).toHaveLength(i === 0 ? 1 : 2);
    }
    expect(ours()[1].run.conclusion).toBe("success");
  });
});

describe("a PR that doesn't link", () => {
  it("gets a failing check that says why, when it names a task it can't link to", async () => {
    fake.addPull("acme/uploader", { number: 20, author: "bob", body: goodBody(taskId), headSha: "g1" }, goodFiles);
    await sendPr(20);
    expect(ours()).toHaveLength(1);
    expect(ours()[0].run).toMatchObject({ conclusion: "failure", title: "Not linked to a task" });
    expect(ours()[0].run.summary).toContain(`@alice took on PI-${taskId}, so only their PR links to it.`);
    expect(await db.select().from(submissions)).toHaveLength(0);
  });

  it("gets no check at all when it doesn't name a task", async () => {
    fake.addPull("acme/uploader", { number: 21, author: "bob", body: "Fix a typo", headSha: "h1" }, goodFiles);
    await sendPr(21);
    expect(ours()).toHaveLength(0);
  });

  it("is ignored when it targets another branch", async () => {
    fake.addPull("acme/uploader", { number: 22, author: "alice", body: goodBody(taskId), headSha: "i1", baseRef: "alice/feature" }, goodFiles);
    await sendPr(22);
    expect(ours()).toHaveLength(0);
    expect(await db.select().from(submissions)).toHaveLength(0);
  });
});

describe("the checks job", () => {
  it("has one dedupe key per PR and head sha, re-armed by later events", async () => {
    await queueChecks(db, { repoId, prNumber: 7 }, "abc");
    await queueChecks(db, { repoId, prNumber: 7 }, "abc");
    let rows = await db.select().from(jobs).where(eq(jobs.type, CHECKS_JOB));
    expect(rows.map((r) => r.dedupeKey)).toEqual([checksJobKey({ repoId, prNumber: 7 }, "abc")]);

    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, rows[0].id));
    await queueChecks(db, { repoId, prNumber: 7 }, "abc");
    rows = await db.select().from(jobs).where(eq(jobs.type, CHECKS_JOB));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("queued");

    await queueChecks(db, { repoId, prNumber: 7 }, "def");
    expect(await db.select().from(jobs).where(eq(jobs.type, CHECKS_JOB))).toHaveLength(2);
  });
});

describe("waiting for CI", () => {
  const job = () => ({ repoId, prNumber: 30 });
  const waitJobs = () => db.select().from(jobs).where(like(jobs.dedupeKey, `${checksJobKey(job(), "w1")}:wait@%`));

  it("queues one follow-up per minute however many events arrive, not parallel chains", async () => {
    fake.addPull("acme/uploader", { number: 30, author: "alice", body: goodBody(taskId), headSha: "w1" }, goodFiles);
    fake.setCi("acme/uploader", "w1", [{ name: "test", status: "in_progress", conclusion: null }]);
    await sendPr(30);
    const now = new Date();
    for (let i = 0; i < 3; i++) await runChecks(db, { gh: fake.gh, scanner: noSecrets }, job(), now);
    expect(await waitJobs()).toHaveLength(1);
  });

  it("stops waiting an hour after CI was first seen running, and reports it as failing", async () => {
    fake.addPull("acme/uploader", { number: 30, author: "alice", body: goodBody(taskId), headSha: "w1" }, goodFiles);
    fake.setCi("acme/uploader", "w1", [{ name: "test", status: "in_progress", conclusion: null }]);
    const start = new Date();
    await sendPr(30);
    // Many quick re-runs don't use the hour up.
    for (let i = 0; i < 70; i++) await runChecks(db, { gh: fake.gh, scanner: noSecrets }, job(), new Date(start.getTime() + i * 1000));
    expect((await db.select().from(submissions))[0].status).toBe("checking");

    const out = await runChecks(db, { gh: fake.gh, scanner: noSecrets }, job(), new Date(start.getTime() + 61 * 60_000));
    expect(out).toMatchObject({ status: "checked", ciPending: false });
    expect((await db.select().from(submissions))[0].status).toBe("checks_failed");
    expect(ours().at(-1)?.run).toMatchObject({ status: "completed", conclusion: "failure" });
  });
});

describe("the site's own check suite", () => {
  it("never triggers a re-check, whatever the App is named", async () => {
    fake.addPull("acme/uploader", { number: 40, author: "alice", body: goodBody(taskId), headSha: "s1" }, goodFiles);
    fake.setCi("acme/uploader", "s1", [{ name: "test", conclusion: "success" }]);
    await sendPr(40);
    const before = ours().length;
    const raw = JSON.stringify({
      action: "completed",
      repository: { id: 42, full_name: "acme/uploader", default_branch: "main" },
      check_suite: { head_sha: "s1", app: { id: 999, name: "Renamed by the admin" }, pull_requests: [{ number: 40 }] },
    });
    await receiveWebhook(db, { secret, rawBody: raw, event: "check_suite", deliveryId: "own-suite", signature: sign(raw) });
    const withId = createHandlers({ repoGitHub: () => fake.gh, scanner: () => noSecrets, appId: () => 999 });
    while (await runNextJob(db, withId, quiet)) {
      /* run */
    }
    expect(ours()).toHaveLength(before);
  });
});

describe("GitHub as the owner's inbox", () => {
  it("asks for the task owner's review once, when the PR passes, and links the check run to the task page", async () => {
    fake.addPull("acme/uploader", { number: 50, author: "alice", body: goodBody(taskId), headSha: "r1" }, goodFiles);
    fake.setCi("acme/uploader", "r1", [{ name: "test", conclusion: "success" }]);
    await sendPr(50);
    await runChecks(db, { gh: fake.gh, scanner: noSecrets, appUrl: "http://pitch-in.local" }, { repoId, prNumber: 50 });
    expect(fake.world.reviewRequests).toEqual([{ fullName: "acme/uploader", number: 50, login: "olive" }]);
    expect(ours().at(-1)?.run.detailsUrl).toBe(`http://pitch-in.local/tasks/${taskId}`);

    fake.world.pulls.get("acme/uploader#50")!.headSha = "r2";
    fake.setCi("acme/uploader", "r2", [{ name: "test", conclusion: "success" }]);
    await sendPr(50, "synchronize");
    expect(fake.world.reviewRequests).toHaveLength(1);
  });

  it("doesn't ask while checks are failing", async () => {
    fake.addPull("acme/uploader", { number: 51, author: "alice", body: goodBody(taskId), headSha: "r3" }, goodFiles);
    fake.setCi("acme/uploader", "r3", [{ name: "test", conclusion: "failure" }]);
    await sendPr(51);
    expect(fake.world.reviewRequests).toEqual([]);
  });
});

describe("gates and warnings", () => {
  it("lets a PR with only format warnings reach review, with a neutral check run", async () => {
    const sloppy = goodBody(taskId, {
      criteria: [
        "- [x] Empty files get a 400 error -> src/upload.py",
        "- [x] A test covers the empty file -> tests/test_upload.py:1",
        "- [ ] All existing tests pass -> CI",
      ],
    });
    fake.addPull("acme/uploader", { number: 60, author: "alice", body: sloppy, headSha: "g1" }, goodFiles);
    fake.setCi("acme/uploader", "g1", [{ name: "test", conclusion: "success" }]);
    await sendPr(60);
    const run = ours()[0].run;
    expect(run.conclusion).toBe("neutral");
    expect(run.summary.split("\n")[0]).toBe("Pitch In checks: 5 passed, 0 failed, 2 warnings");
    expect(run.summary).toContain("⚠ Criteria");
    expect((await db.select().from(submissions))[0].status).toBe("in_review");
  });
});
