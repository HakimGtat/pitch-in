import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermissionError } from "@/lib/admin";
import { adoptMilestone, adoptTask, handBack, releaseAdoption } from "@/lib/adoption";
import { emptyBrief, type BriefDraft } from "@/lib/brief";
import type { Db } from "@/lib/db/client";
import { adoptions, auditLog, milestones, repos, tasks } from "@/lib/db/schema";
import type { RepoGitHub } from "@/lib/github/repos";
import { filterBoard } from "@/lib/board-rules";
import { connectRepo, refreshRepo, removeRepo, updateRepoSettings } from "@/lib/repos";
import { loadBoard, loadProjectView, loadTaskView } from "@/lib/views";
import { closeProject, closeTask, createProject, editTask, postTask } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const HOUR = 3600_000;
const t0 = new Date("2026-11-23T12:00:00Z");
const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);

const draft = (over: Partial<BriefDraft> = {}, brief: Partial<BriefDraft["brief"]> = {}): BriefDraft => ({
  title: "Reject empty uploads",
  kind: "code",
  sizeTier: "small",
  allowedPaths: ["src/**", "tests/**"],
  ...over,
  brief: {
    ...emptyBrief(),
    goal: "Empty files are rejected before they reach storage.",
    files: ["src/upload.py"],
    acceptance: ["Empty files get a 400 error"],
    testCommand: "pytest",
    constraints: "No new dependencies.",
    ...brief,
  },
});

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());

let gh: RepoGitHub;
let world: ReturnType<typeof fakeGitHub>;
let owner: { id: number };
let alice: { id: number };
let bob: { id: number };
let guided: { id: number };
let admin: { id: number };

const REPO_FILES = {
  "PROJECT_BRIEF.md": "# Uploader\nA small upload service.",
  ".github/workflows/ci.yml": "name: ci",
  "src/upload.py": "def validate_file(): ...",
  "tests/test_upload.py": "def test(): ...",
  "README.md": "readme",
};

beforeEach(async () => {
  await reset();
  world = fakeGitHub();
  gh = world.gh;
  owner = await insertUser(db, { handle: "olive" });
  alice = await insertUser(db, { handle: "alice" });
  bob = await insertUser(db, { handle: "bob" });
  guided = await insertUser(db, { handle: "gus", profile: "guided" });
  admin = await insertUser(db, { handle: "boss", isOrgOwner: true });
  world.addRepo(1, "acme/uploader", { ...REPO_FILES }, { olive: "admin", alice: "write", bob: "read" });
  world.addRepo(2, "acme/no-ci", { "README.md": "x" }, { olive: "admin" });
  world.addRepo(3, "acme/no-brief", { ".github/workflows/lint.yaml": "x", "README.md": "x" }, { olive: "admin" });
});

async function connected(id = 1) {
  const r = await connectRepo(db, gh, owner.id, id, t0);
  if (!r.ok) throw new Error("expected the repo to connect");
  return r.repoId;
}

async function postProject(repoId: number) {
  const r = await createProject(
    db,
    gh,
    owner.id,
    repoId,
    {
      title: "Uploader v2",
      goal: "Make uploads safe.",
      milestones: [
        { title: "Validation", goal: "Bad files never reach storage." },
        { title: "Speed", goal: "Uploads finish faster." },
      ],
    },
    t0,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.flags));
  const ms = await db.select().from(milestones).where(eq(milestones.projectId, r.projectId)).orderBy(milestones.position);
  return { projectId: r.projectId, m1: ms[0].id, m2: ms[1].id };
}

async function addTask(milestoneId: number, title: string, sizeTier: BriefDraft["sizeTier"] = "small") {
  const r = await postTask(db, gh, owner.id, { milestoneId }, draft({ title, sizeTier }), false, t0);
  if (!r.ok) throw new Error(JSON.stringify(r.check.errors));
  return r.taskId;
}

describe("connecting a repo", () => {
  it("works for a repo admin, reads PROJECT_BRIEF.md and writes the audit log", async () => {
    const r = await connectRepo(db, gh, owner.id, 1, t0);
    expect(r).toEqual({ ok: true, repoId: expect.any(Number), briefMissing: false });
    const [repo] = await db.select().from(repos);
    expect(repo.fullName).toBe("acme/uploader");
    expect(repo.hasCi).toBe(true);
    expect(repo.projectBrief).toContain("A small upload service.");
    expect(repo.installationId).toBe(777);
    const log = await db.select().from(auditLog).where(eq(auditLog.action, "repo.connected"));
    expect(log).toHaveLength(1);
  });

  it("is refused without CI", async () => {
    const r = await connectRepo(db, gh, owner.id, 2, t0);
    expect(r).toEqual({ ok: false, reason: "no_ci", fullName: "acme/no-ci" });
    expect(await db.select().from(repos)).toHaveLength(0);
  });

  it("connects with a warning when PROJECT_BRIEF.md is missing", async () => {
    const r = await connectRepo(db, gh, owner.id, 3, t0);
    expect(r).toMatchObject({ ok: true, briefMissing: true });
  });

  it("is only for repo admins on GitHub", async () => {
    await expect(connectRepo(db, gh, alice.id, 1, t0)).rejects.toThrow(/admin permission/);
  });

  it("refreshes PROJECT_BRIEF.md and CI from GitHub", async () => {
    const repoId = await connected();
    world.world.files.get("acme/uploader")!["PROJECT_BRIEF.md"] = "# Uploader\nNow with a repo map.";
    delete world.world.files.get("acme/uploader")![".github/workflows/ci.yml"];
    const repo = await refreshRepo(db, gh, repoId, at(1));
    expect(repo.projectBrief).toContain("repo map");
    expect(repo.hasCi).toBe(false);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "repo.ci_missing"))).toHaveLength(1);
  });

  it("has settings for repo admins and site admins only", async () => {
    const repoId = await connected();
    const settings = { largestTier: "medium" as const, offLimitsPaths: ["infra/**"], sizeCapIgnore: ["package-lock.json"] };
    await expect(updateRepoSettings(db, gh, alice.id, repoId, settings, t0)).rejects.toThrow(PermissionError);
    await updateRepoSettings(db, gh, admin.id, repoId, settings, t0);
    const [repo] = await db.select().from(repos);
    expect(repo.settings).toEqual(settings);
  });
});

describe("posting work", () => {
  it("lets a coworker with write access post, with no ai-team membership needed", async () => {
    const repoId = await connected();
    const r = await postTask(db, gh, alice.id, { repoId }, draft(), false, t0);
    expect(r.ok).toBe(true);
  });

  it("refuses people without write access, checked fresh on GitHub", async () => {
    const repoId = await connected();
    await expect(postTask(db, gh, bob.id, { repoId }, draft(), false, t0)).rejects.toThrow(/write access/);
    world.world.perms.get("acme/uploader")!.bob = "write";
    expect((await postTask(db, gh, bob.id, { repoId }, draft(), false, t0)).ok).toBe(true);
  });

  it("returns the brief checker's errors and saves nothing", async () => {
    const repoId = await connected();
    const r = await postTask(db, gh, alice.id, { repoId }, draft({}, { files: ["src/nope.py"], goal: "" }), false, t0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.check.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["goal", "files"]));
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("asks for 'Post anyway' on warnings only", async () => {
    const repoId = await connected();
    const d = draft({ allowedPaths: ["src/**", "docs/new/**"] });
    const first = await postTask(db, gh, alice.id, { repoId }, d, false, t0);
    expect(first).toMatchObject({ ok: false, needsAck: true });
    expect((await postTask(db, gh, alice.id, { repoId }, d, true, t0)).ok).toBe(true);
  });

  it("posts a project with two milestones, and tasks in order", async () => {
    const repoId = await connected();
    const { projectId, m1, m2 } = await postProject(repoId);
    const a = await addTask(m1, "First");
    const b = await addTask(m1, "Second", "medium");
    await addTask(m2, "Other");
    const rows = await db.select().from(tasks).where(eq(tasks.milestoneId, m1)).orderBy(tasks.position);
    expect(rows.map((t) => [t.id, t.position, t.projectId])).toEqual([
      [a, 1, projectId],
      [b, 2, projectId],
    ]);
  });

  it("only lets the project's owner add tasks to it", async () => {
    const repoId = await connected();
    const { m1 } = await postProject(repoId);
    await expect(postTask(db, gh, alice.id, { milestoneId: m1 }, draft(), false, t0)).rejects.toThrow(/Only the owner/);
  });

  it("flags secrets and outside links in project goals", async () => {
    const repoId = await connected();
    const r = await createProject(
      db,
      gh,
      owner.id,
      repoId,
      { title: "X", goal: "See https://evil.example/run.sh", milestones: [{ title: "M", goal: "token = abcdefgh12345" }] },
      t0,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.flags.map((f) => f.message).join("\n");
      expect(text).toMatch(/Link outside the repo: https:\/\/evil\.example/);
      expect(text).toMatch(/Milestone 1: Looks like a secret/);
    }
  });

  it("lets the owner edit an open task, but not once it's taken", async () => {
    const repoId = await connected();
    const r = await postTask(db, gh, owner.id, { repoId }, draft(), false, t0);
    if (!r.ok) throw new Error();
    expect((await editTask(db, gh, owner.id, r.taskId, draft({ title: "Better title" }), false, t0)).ok).toBe(true);
    await adoptTask(db, alice.id, r.taskId, t0);
    await expect(editTask(db, gh, owner.id, r.taskId, draft(), false, t0)).rejects.toThrow(/Only open tasks/);
  });
});

describe("the board", () => {
  it("shows someone who picked a quick run only Small tasks, grouped by project", async () => {
    const repoId = await connected();
    const { m1, m2 } = await postProject(repoId);
    await addTask(m1, "Small one", "small");
    await addTask(m1, "Medium one", "medium");
    await addTask(m2, "Large one", "large");
    await postTask(db, gh, owner.id, { repoId }, draft({ title: "Single small" }), false, t0);
    await postTask(db, gh, owner.id, { repoId }, draft({ title: "Single large", sizeTier: "large" }), false, t0);

    const viewer = { id: alice.id, isMainAdmin: false, isOrgOwner: false, blocked: false, profile: "developer" as const };
    const view = filterBoard(await loadBoard(db, viewer, t0), "quick");
    expect(view.projects.map((p) => p.title)).toEqual(["Uploader v2"]);
    expect(view.projects[0].milestones.map((m) => m.tasks.map((t) => t.title))).toEqual([["Small one"]]);
    expect(view.singles.map((t) => t.title)).toEqual(["Single small"]);
  });
});

describe("adoption and the 48-hour lock", () => {
  async function singleTask() {
    const repoId = await connected();
    const r = await postTask(db, gh, owner.id, { repoId }, draft(), false, t0);
    if (!r.ok) throw new Error();
    return r.taskId;
  }

  it("locks a task so a second adoption is blocked", async () => {
    const id = await singleTask();
    await adoptTask(db, alice.id, id, t0);
    await expect(adoptTask(db, bob.id, id, at(1))).rejects.toThrow(/@alice has taken this on/);
    const view = await loadTaskView(db, id, at(1));
    expect(view?.status).toBe("adopted");
    expect(view?.holder?.handle).toBe("alice");
  });

  it("lapses at 48 hours, computed on read, and someone else can then adopt", async () => {
    const id = await singleTask();
    await adoptTask(db, alice.id, id, t0);
    expect((await loadTaskView(db, id, at(47.9)))?.status).toBe("adopted");
    const lapsed = await loadTaskView(db, id, at(48));
    expect(lapsed?.status).toBe("open");
    expect(lapsed?.holder).toBeNull();

    await adoptTask(db, bob.id, id, at(49));
    const rows = await db.select().from(adoptions).orderBy(adoptions.id);
    expect(rows.map((a) => [a.userId, a.status])).toEqual([
      [alice.id, "expired"],
      [bob.id, "active"],
    ]);
    expect(rows[0].endedAt?.toISOString()).toBe(at(48).toISOString());
  });

  it("isn't open to the task's owner", async () => {
    const id = await singleTask();
    await expect(adoptTask(db, owner.id, id, t0)).rejects.toThrow(/your own work/);
  });

  it("can be handed back any time without an open PR, and the task reopens", async () => {
    const id = await singleTask();
    await adoptTask(db, alice.id, id, t0);
    await expect(handBack(db, bob.id, id, at(1))).rejects.toThrow(/Only the person/);
    await handBack(db, alice.id, id, at(1));
    expect((await loadTaskView(db, id, at(1)))?.status).toBe("open");
    await adoptTask(db, bob.id, id, at(2));
  });

  it("can be released early by the owner or an admin, and the release is audited", async () => {
    const id = await singleTask();
    await adoptTask(db, alice.id, id, t0);
    await expect(releaseAdoption(db, bob.id, id, at(1))).rejects.toThrow(PermissionError);
    await releaseAdoption(db, admin.id, id, at(1));
    expect((await loadTaskView(db, id, at(1)))?.holder).toBeNull();
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "adoption.released"))).toHaveLength(1);
  });

  it("is released when the owner closes the task", async () => {
    const id = await singleTask();
    await adoptTask(db, alice.id, id, t0);
    await closeTask(db, owner.id, id, at(1));
    const [a] = await db.select().from(adoptions);
    expect(a.status).toBe("released");
    expect((await loadTaskView(db, id, at(1)))?.status).toBe("closed");
  });
});

describe("milestones", () => {
  it("only lets the milestone's next task be adopted on its own", async () => {
    const repoId = await connected();
    const { m1 } = await postProject(repoId);
    const first = await addTask(m1, "First");
    const second = await addTask(m1, "Second");
    await expect(adoptTask(db, alice.id, second, t0)).rejects.toThrow(/Task 1 \(First\) comes first/);
    await adoptTask(db, alice.id, first, t0);
  });

  it("locks every open task when a member adopts a whole milestone, and blocks adopting any of them again", async () => {
    const repoId = await connected();
    const { m1, m2 } = await postProject(repoId);
    const ids = [await addTask(m1, "First"), await addTask(m1, "Second"), await addTask(m1, "Third")];
    const other = await addTask(m2, "Elsewhere");

    expect(await adoptMilestone(db, alice.id, m1, t0)).toEqual(ids);
    for (const id of ids) {
      await expect(adoptTask(db, bob.id, id, at(1))).rejects.toThrow(PermissionError);
    }
    await expect(adoptMilestone(db, bob.id, m1, at(1))).rejects.toThrow(/@alice is already working on this milestone/);
    const [m] = await db.select().from(milestones).where(eq(milestones.id, m1));
    expect(m.status).toBe("in_progress");

    // Milestones run side by side: the other one is still free.
    await adoptTask(db, bob.id, other, at(1));
  });

  it("frees the whole milestone at 48 hours", async () => {
    const repoId = await connected();
    const { m1 } = await postProject(repoId);
    await addTask(m1, "First");
    await addTask(m1, "Second");
    await adoptMilestone(db, alice.id, m1, t0);
    await expect(adoptMilestone(db, bob.id, m1, at(47))).rejects.toThrow(PermissionError);
    expect(await adoptMilestone(db, bob.id, m1, at(48))).toHaveLength(2);
  });

  it("hands back a whole milestone from any of its tasks, and the rest reopen", async () => {
    const repoId = await connected();
    const { m1, projectId } = await postProject(repoId);
    const ids = [await addTask(m1, "First"), await addTask(m1, "Second")];
    await adoptMilestone(db, alice.id, m1, t0);
    expect(await handBack(db, alice.id, ids[1], at(2))).toEqual(ids);

    const viewer = { id: bob.id, isMainAdmin: false, isOrgOwner: false, blocked: false, profile: "developer" as const };
    const project = await loadProjectView(db, projectId, viewer, at(2));
    expect(project?.milestones[0].tasks.map((t) => t.status)).toEqual(["open", "open"]);
    expect(project?.milestones[0].adoptWhole.ok).toBe(true);
    expect(project?.milestones[0].tasks.map((t) => t.adopt.ok)).toEqual([true, false]);
  });

  it("closes a project's tasks and releases everyone when it's closed", async () => {
    const repoId = await connected();
    const { m1, projectId } = await postProject(repoId);
    await addTask(m1, "First");
    await adoptMilestone(db, alice.id, m1, t0);
    await expect(closeProject(db, alice.id, projectId, at(1))).rejects.toThrow(PermissionError);
    await closeProject(db, owner.id, projectId, at(1));
    const rows = await db.select().from(tasks);
    expect(rows.every((t) => t.status === "closed")).toBe(true);
    expect((await db.select().from(adoptions)).every((a) => a.status === "released")).toBe(true);
  });

  it("keeps Guided users off developer-only tasks", async () => {
    const repoId = await connected();
    const r = await postTask(db, gh, owner.id, { repoId }, draft(), false, t0);
    if (!r.ok) throw new Error();
    await db.update(tasks).set({ developersOnly: true }).where(eq(tasks.id, r.taskId));
    await expect(adoptTask(db, guided.id, r.taskId, t0)).rejects.toThrow(/marked this task for developers/);
  });
});

describe("removing a repo", () => {
  it("is for admins, and closes its open work", async () => {
    const repoId = await connected();
    const r = await postTask(db, gh, owner.id, { repoId }, draft(), false, t0);
    if (!r.ok) throw new Error();
    await adoptTask(db, alice.id, r.taskId, t0);
    await expect(removeRepo(db, owner.id, repoId, at(1))).rejects.toThrow(/Only admins/);
    await removeRepo(db, admin.id, repoId, at(1));
    expect((await loadTaskView(db, r.taskId, at(1)))?.status).toBe("closed");
    // It can be connected again later.
    expect((await connectRepo(db, gh, owner.id, 1, at(2))).ok).toBe(true);
  });
});
