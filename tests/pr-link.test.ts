import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermissionError } from "@/lib/admin";
import { adoptTask, handBack } from "@/lib/adoption";
import { CHECKS_JOB } from "@/lib/checks/run";
import { emptyBrief } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { auditLog, submissions, jobs } from "@/lib/db/schema";
import {
  decideLink,
  handlePullRequestEvent,
  linkPastedPr,
  linkPullRequest,
  parsePrUrl,
  parseTaskLine,
  type LinkTarget,
  type PullRequestInfo,
} from "@/lib/pr-link";
import { connectRepo } from "@/lib/repos";
import { postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const t0 = new Date("2026-11-23T12:00:00Z");

describe("parseTaskLine", () => {
  it("reads Task: PI-<id> and Task: <id> on the first line", () => {
    expect(parseTaskLine("Task: PI-9\n\n## Summary")).toBe(9);
    expect(parseTaskLine("Task: 12")).toBe(12);
    expect(parseTaskLine("  task:   pi-7  \r\nmore")).toBe(7);
  });
  it("skips leading blank lines and a byte-order mark", () => {
    expect(parseTaskLine("\n\nTask: PI-3")).toBe(3);
    expect(parseTaskLine("﻿Task: PI-3")).toBe(3);
  });
  it("finds nothing unless it's the first line", () => {
    expect(parseTaskLine("## Summary\nTask: PI-9")).toBeNull();
    expect(parseTaskLine("Fixes Task: PI-9")).toBeNull();
    expect(parseTaskLine("Task: PI-9 and PI-10")).toBeNull();
    expect(parseTaskLine("Task: PI-0")).toBeNull();
    expect(parseTaskLine("Task: abc")).toBeNull();
    expect(parseTaskLine("")).toBeNull();
    expect(parseTaskLine(null)).toBeNull();
  });
});

describe("parsePrUrl", () => {
  it("reads PR addresses", () => {
    expect(parsePrUrl("https://github.com/acme/uploader/pull/12")).toEqual({ repo: "acme/uploader", number: 12 });
    expect(parsePrUrl(" https://github.com/acme/uploader/pull/12/files?x=1#y ")).toEqual({ repo: "acme/uploader", number: 12 });
  });
  it("rejects everything else", () => {
    for (const bad of [
      "https://github.com/acme/uploader/issues/12",
      "http://github.com/acme/uploader/pull/12",
      "https://evil.example/github.com/acme/uploader/pull/12",
      "https://github.com/acme/uploader/pull/0",
      "https://github.com/acme/uploader/pull/x",
      "PR 12",
      "",
    ]) {
      expect(parsePrUrl(bad)).toBeNull();
    }
  });
});

describe("decideLink", () => {
  const task: LinkTarget = { id: 9, repoId: 1, status: "adopted", holderHandle: "alice" };
  type Input = Parameters<typeof decideLink>[0];
  const base: Input = { taskId: 9, task, repoId: 1, authorHandle: "alice" };
  it("links the adopter's PR, ignoring handle case", () => {
    expect(decideLink(base)).toEqual({ linked: true, taskId: 9 });
    expect(decideLink({ ...base, authorHandle: "Alice" })).toEqual({ linked: true, taskId: 9 });
  });
  it("gives a reason for each way of not linking", () => {
    const reason = (over: Partial<Input>) => {
      const d = decideLink({ ...base, ...over });
      expect(d.linked).toBe(false);
      return d.linked ? "" : d.reason;
    };
    expect(reason({ taskId: null, task: null })).toMatch(/Task: PI-/);
    expect(reason({ task: null })).toMatch(/PI-9 isn't a task/);
    expect(reason({ repoId: 2 })).toMatch(/isn't a task in this repo/);
    expect(reason({ authorHandle: "bob" })).toMatch(/@alice took on PI-9/);
    expect(reason({ task: { ...task, holderHandle: null } })).toMatch(/Nobody has taken on/);
    expect(reason({ task: { ...task, status: "merged" } })).toMatch(/finished/);
    expect(reason({ task: { ...task, status: "closed" } })).toMatch(/finished/);
  });
});

describe("linking PRs", () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;
  let repo: { id: number; fullName: string; defaultBranch: string };
  let owner: { id: number };
  let alice: { id: number };
  let bob: { id: number };
  let taskId: number;

  beforeAll(async () => {
    ({ db, reset, close } = await createTestDb());
  });
  afterAll(() => close());

  beforeEach(async () => {
    await reset();
    const world = fakeGitHub();
    world.addRepo(1, "acme/uploader", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
    owner = await insertUser(db, { handle: "olive" });
    alice = await insertUser(db, { handle: "alice" });
    bob = await insertUser(db, { handle: "bob" });
    const connected = await connectRepo(db, world.gh, owner.id, 1);
    if (!connected.ok) throw new Error("repo not connected");
    const posted = await postTask(
      db,
      world.gh,
      owner.id,
      { repoId: connected.repoId },
      {
        title: "Reject empty uploads",
        kind: "code",
        sizeTier: "small",
        allowedPaths: ["src/**"],
        brief: { ...emptyBrief(), goal: "Reject empty files.", files: ["src/a.ts"], acceptance: ["Empty files get a 400"], testCommand: "npm test", constraints: "None." },
      },
      true,
      t0,
    );
    if (!posted.ok) throw new Error("task not posted");
    taskId = posted.taskId;
    await adoptTask(db, alice.id, taskId, t0);
    repo = { id: connected.repoId, fullName: "acme/uploader", defaultBranch: "main" };
  });

  const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
    repoId: repo.id,
    repoFullName: repo.fullName,
    defaultBranch: "main",
    number: 5,
    baseRef: "main",
    headSha: "abc123",
    authorHandle: "alice",
    body: `Task: PI-${taskId}\n\n## Summary`,
    draft: false,
    ...over,
  });
  const unlinkedLog = () => db.select().from(auditLog).where(eq(auditLog.action, "pr.unlinked"));

  it("links a body starting with Task: <id> to that task", async () => {
    const out = await linkPullRequest(db, pr(), t0);
    expect(out).toMatchObject({ status: "linked", taskId });
    const [row] = await db.select().from(submissions);
    expect(row).toMatchObject({ taskId, prNumber: 5, headSha: "abc123", authorId: alice.id, status: "checking" });
    expect(await unlinkedLog()).toHaveLength(0);
  });

  it("links a draft PR", async () => {
    expect(await linkPullRequest(db, pr({ draft: true }), t0)).toMatchObject({ status: "linked", taskId });
    expect(await db.select().from(submissions)).toHaveLength(1);
  });

  it("doesn't link another person's PR, and says why", async () => {
    const out = await linkPullRequest(db, pr({ authorHandle: "bob" }), t0);
    expect(out).toMatchObject({ status: "unlinked", reason: expect.stringContaining("@alice took on") });
    expect(await db.select().from(submissions)).toHaveLength(0);
    const [entry] = await unlinkedLog();
    expect(entry).toMatchObject({ target: "acme/uploader#5", details: { author: "bob", taskId } });
  });

  it("notes an unlinked PR once, not on every push", async () => {
    await linkPullRequest(db, pr({ body: "no line" }), t0);
    await linkPullRequest(db, pr({ body: "no line", headSha: "next" }), t0);
    expect(await unlinkedLog()).toHaveLength(1);
    await linkPullRequest(db, pr({ body: "Task: PI-999" }), t0);
    expect(await unlinkedLog()).toHaveLength(2);
  });

  it("doesn't link the owner's own PR either", async () => {
    const out = await linkPullRequest(db, pr({ authorHandle: "olive" }), t0);
    expect(out.status).toBe("unlinked");
  });

  it("stores a PR with no task line as unlinked", async () => {
    const out = await linkPullRequest(db, pr({ body: "Just a fix" }), t0);
    expect(out).toMatchObject({ status: "unlinked", reason: expect.stringContaining("Task: PI-") });
    expect(await db.select().from(submissions)).toHaveLength(0);
    expect(await unlinkedLog()).toHaveLength(1);
    expect((await linkPullRequest(db, pr({ body: null, number: 6 }), t0)).status).toBe("unlinked");
  });

  it("stores a PR with an unknown task id as unlinked", async () => {
    const out = await linkPullRequest(db, pr({ body: "Task: PI-999" }), t0);
    expect(out).toMatchObject({ status: "unlinked", reason: expect.stringContaining("PI-999") });
    expect(await unlinkedLog()).toHaveLength(1);
  });

  it("doesn't link once the adopter handed the task back", async () => {
    await handBack(db, alice.id, taskId, t0);
    expect((await linkPullRequest(db, pr(), t0)).status).toBe("unlinked");
  });

  it("ignores a PR into another branch: no link, no record", async () => {
    expect(await linkPullRequest(db, pr({ baseRef: "alice/feature" }), t0)).toEqual({ status: "ignored" });
    expect(await linkPullRequest(db, pr({ baseRef: "other", authorHandle: "bob" }), t0)).toEqual({ status: "ignored" });
    expect(await db.select().from(submissions)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "pr.unlinked"))).toHaveLength(0);
  });

  it("links once, and a later push only moves the head commit", async () => {
    await linkPullRequest(db, pr(), t0);
    const again = await linkPullRequest(db, pr({ headSha: "def456", body: "edited, no task line" }), t0);
    expect(again).toMatchObject({ status: "linked", taskId });
    const rows = await db.select().from(submissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].headSha).toBe("def456");
  });

  describe("from the webhook", () => {
    const body = (over: Record<string, unknown> = {}) => ({
      pull_request: {
        number: 5,
        draft: true,
        body: `Task: PI-${taskId}`,
        user: { login: "alice" },
        base: { ref: "main" },
        head: { sha: "abc123" },
        ...over,
      },
    });
    it("links opened, edited and draft PRs", async () => {
      expect(await handlePullRequestEvent(db, "opened", body(), repo, t0)).toMatchObject({ status: "linked", taskId });
      expect(await handlePullRequestEvent(db, "synchronize", body({ head: { sha: "new" } }), repo, t0)).toMatchObject({ status: "linked" });
      expect((await db.select().from(submissions))[0].headSha).toBe("new");
    });
    it("leaves other actions and malformed bodies alone", async () => {
      expect(await handlePullRequestEvent(db, "closed", body(), repo, t0)).toBeNull();
      expect(await handlePullRequestEvent(db, "labeled", body(), repo, t0)).toBeNull();
      expect(await handlePullRequestEvent(db, null, body(), repo, t0)).toBeNull();
      expect(await handlePullRequestEvent(db, "opened", {}, repo, t0)).toBeNull();
    });
    it("ignores PRs into other branches", async () => {
      expect(await handlePullRequestEvent(db, "opened", body({ base: { ref: "dev" } }), repo, t0)).toEqual({ status: "ignored" });
    });
  });

  describe("a pasted link", () => {
    const url = (n = 8) => `https://github.com/acme/uploader/pull/${n}`;

    it("links the PR when the adopter pastes it", async () => {
      const out = await linkPastedPr(db, alice.id, taskId, url(), t0);
      expect(out.prNumber).toBe(8);
      const [row] = await db.select().from(submissions);
      expect(row).toMatchObject({ taskId, prNumber: 8, authorId: alice.id, headSha: "", status: "checking" });
    });

    it("queues the checks for the pasted PR right away", async () => {
      await linkPastedPr(db, alice.id, taskId, url(), t0);
      const queued = await db.select().from(jobs).where(eq(jobs.type, CHECKS_JOB));
      expect(queued).toHaveLength(1);
      expect(queued[0].payload).toEqual({ repoId: repo.id, prNumber: 8 });
    });

    it("links the PR when the task owner pastes it, as the adopter's", async () => {
      await linkPastedPr(db, owner.id, taskId, url(), t0);
      expect((await db.select().from(submissions))[0].authorId).toBe(alice.id);
    });

    it("then the webhook fills in the head commit instead of recording it unlinked", async () => {
      await linkPastedPr(db, alice.id, taskId, url(5), t0);
      const out = await linkPullRequest(db, pr({ body: "no task line" }), t0);
      expect(out).toMatchObject({ status: "linked", taskId });
      expect((await db.select().from(submissions))[0].headSha).toBe("abc123");
      expect(await unlinkedLog()).toHaveLength(0);
    });

    it("refuses anyone else", async () => {
      await expect(linkPastedPr(db, bob.id, taskId, url(), t0)).rejects.toThrow(PermissionError);
      expect(await db.select().from(submissions)).toHaveLength(0);
    });

    it("refuses a bad address, another repo, and a PR linked elsewhere", async () => {
      await expect(linkPastedPr(db, alice.id, taskId, "not a link", t0)).rejects.toThrow(/web address/);
      await expect(linkPastedPr(db, alice.id, taskId, "https://github.com/acme/other/pull/1", t0)).rejects.toThrow(/acme\/other/);
      await linkPastedPr(db, alice.id, taskId, url(), t0);
      await expect(linkPastedPr(db, alice.id, taskId, url(), t0)).rejects.toThrow(/already linked/);
    });

    it("refuses someone who handed the task back", async () => {
      await handBack(db, alice.id, taskId, t0);
      await expect(linkPastedPr(db, alice.id, taskId, url(), t0)).rejects.toThrow(/Only the person who took this on, or its owner/);
    });

    it("refuses a PR already linked to another task", async () => {
      await linkPullRequest(db, pr({ number: 5 }), t0);
      const world = fakeGitHub();
      world.addRepo(1, "acme/uploader", { "PROJECT_BRIEF.md": "x", ".github/workflows/ci.yml": "x", "src/a.ts": "x" }, { olive: "admin" });
      const second = await postTask(
        db,
        world.gh,
        owner.id,
        { repoId: repo.id },
        {
          title: "Another one",
          kind: "code",
          sizeTier: "small",
          allowedPaths: ["src/**"],
          brief: { ...emptyBrief(), goal: "Do more.", files: ["src/a.ts"], acceptance: ["Works"], testCommand: "npm test", constraints: "None." },
        },
        true,
        t0,
      );
      if (!second.ok) throw new Error("second task not posted");
      await adoptTask(db, alice.id, second.taskId, t0);
      await expect(linkPastedPr(db, alice.id, second.taskId, url(5), t0)).rejects.toThrow(/already linked to PI-/);
    });
  });
});
