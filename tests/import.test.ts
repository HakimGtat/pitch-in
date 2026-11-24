import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { auditLog, milestones, projects, tasks } from "@/lib/db/schema";
import type { RepoGitHub } from "@/lib/github/repos";
import { connectRepo } from "@/lib/repos";
import { importPlan } from "@/lib/work";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const t0 = new Date("2026-11-23T12:00:00Z");

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
let reader: { id: number };
let repoId: number;

const task = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  kind: "code",
  estimate: "small",
  goal: `${title} works.`,
  files: ["src/upload.py"],
  allowedPaths: ["src/**", "tests/**"],
  acceptance: [`${title} is done`, "All existing tests pass"],
  testCommand: "pytest",
  constraints: "No new dependencies.",
  ...over,
});

const plan = (over: { tasks2?: unknown[] } = {}) =>
  JSON.stringify({
    project: { title: "Uploader v2", goal: "Make uploads safe and fast." },
    milestones: [
      { title: "Validation", goal: "Bad files never reach storage.", tasks: [task("Reject empty files"), task("Reject huge files")] },
      { title: "Speed", goal: "Uploads finish faster.", tasks: over.tasks2 ?? [task("Stream uploads", { estimate: "medium" })] },
    ],
  });

beforeEach(async () => {
  await reset();
  world = fakeGitHub();
  gh = world.gh;
  owner = await insertUser(db, { handle: "olive" });
  reader = await insertUser(db, { handle: "rita" });
  world.addRepo(
    1,
    "acme/uploader",
    {
      "PROJECT_BRIEF.md": "# Uploader",
      ".github/workflows/ci.yml": "name: ci",
      "src/upload.py": "def validate_file(): ...",
      "tests/test_upload.py": "def test(): ...",
    },
    { olive: "admin", rita: "read" },
  );
  const r = await connectRepo(db, gh, owner.id, 1, t0);
  if (!r.ok) throw new Error("expected the repo to connect");
  repoId = r.repoId;
});

const check = (text: string) => importPlan(db, gh, owner.id, repoId, text, { post: false, acknowledged: false }, t0);
const post = (text: string, acknowledged = false) => importPlan(db, gh, owner.id, repoId, text, { post: true, acknowledged }, t0);

describe("importing a plan", () => {
  it("checks without writing anything", async () => {
    const r = await check(plan());
    expect(r).toMatchObject({ kind: "preview", preview: { errors: 0, warnings: 0, tasks: 3 } });
    expect(await db.select().from(projects)).toHaveLength(0);
  });

  it("posts the project, its milestones and tasks together, in order", async () => {
    const r = await post(plan());
    if (r.kind !== "posted") throw new Error(JSON.stringify(r));
    expect(r.taskIds).toHaveLength(3);

    const [project] = await db.select().from(projects);
    expect(project).toMatchObject({ id: r.projectId, repoId, ownerId: owner.id, title: "Uploader v2", status: "open" });

    const ms = await db.select().from(milestones).orderBy(asc(milestones.position));
    expect(ms.map((m) => [m.position, m.title, m.status])).toEqual([
      [1, "Validation", "open"],
      [2, "Speed", "open"],
    ]);

    const ts = await db.select().from(tasks).orderBy(asc(tasks.id));
    expect(ts.map((t) => t.id)).toEqual(r.taskIds);
    expect(ts.map((t) => [t.milestoneId, t.position, t.title, t.sizeTier, t.status])).toEqual([
      [ms[0].id, 1, "Reject empty files", "small", "open"],
      [ms[0].id, 2, "Reject huge files", "small", "open"],
      [ms[1].id, 1, "Stream uploads", "medium", "open"],
    ]);
    expect(ts.every((t) => t.projectId === project.id && t.repoId === repoId && t.ownerId === owner.id)).toBe(true);
    expect(ts[0].briefMd).toContain("# Task: Reject empty files");
    expect(ts[0].brief.acceptance).toEqual(["Reject empty files is done", "All existing tests pass"]);

    const log = await db.select().from(auditLog).where(eq(auditLog.action, "project.imported"));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorId: owner.id, target: `project ${project.id}` });
    expect(log[0].details).toMatchObject({ repo: "acme/uploader", milestones: 2, tasks: r.taskIds.map((id) => `PI-${id}`) });
  });

  it("refuses to post while any task has a flag, and writes nothing", async () => {
    const r = await post(plan({ tasks2: [task("Stream uploads", { files: ["src/stream.py"] })] }));
    expect(r).toMatchObject({ kind: "preview", preview: { errors: 1 } });
    if (r.kind !== "preview") throw new Error("expected a preview");
    expect(r.preview.milestones[1].tasks[0].errors[0].message).toMatch(/src\/stream\.py isn't in acme\/uploader/);
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("posts after the owner fixes the flagged task", async () => {
    const bad = plan({ tasks2: [task("Stream uploads", { files: ["src/stream.py"] })] });
    expect((await post(bad)).kind).toBe("preview");
    const fixed = bad.replace("src/stream.py", "src/upload.py");
    expect((await post(fixed)).kind).toBe("posted");
  });

  it("needs a Post anyway for warnings", async () => {
    const text = plan({ tasks2: [task("Stream uploads", { allowedPaths: ["src/stream/**"] })] });
    expect(await post(text)).toMatchObject({ kind: "preview", preview: { errors: 0, warnings: 1 } });
    expect(await db.select().from(projects)).toHaveLength(0);
    expect((await post(text, true)).kind).toBe("posted");
  });

  it("reports JSON it can't read", async () => {
    expect(await post("Sorry, I couldn't finish the plan.")).toEqual({
      kind: "unparsed",
      errors: [expect.stringMatching(/No JSON/)],
    });
  });

  it("needs write access on GitHub, checked fresh", async () => {
    await expect(importPlan(db, gh, reader.id, repoId, plan(), { post: true, acknowledged: false }, t0)).rejects.toThrow(
      /write access/,
    );
    world.world.perms.get("acme/uploader")!.olive = "read";
    await expect(post(plan())).rejects.toThrow(/write access/);
    expect(await db.select().from(projects)).toHaveLength(0);
  });
});
