import { describe, expect, it } from "vitest";
import {
  canAdoptMilestone,
  canAdoptTask,
  canHandBack,
  nextTaskInMilestone,
  waitsItsTurn,
  type AdoptActor,
  type TaskView,
} from "@/lib/adoption-rules";
import { filterBoard, type BoardData } from "@/lib/board-rules";
import { effectiveTaskStatus, isHeld, LOCK_HOURS, lockExpiry, milestoneStatus, timeLeft } from "@/lib/lock";
import { fitsTakeOn, offersWholeMilestones, tierAllowed } from "@/lib/sizing";

const HOUR = 3600_000;
const t0 = new Date("2026-11-23T12:00:00Z");
const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);

describe("the 'work that fits' filter", () => {
  it("shows a quick run only Small tasks", () => {
    expect(fitsTakeOn("quick", "small")).toBe(true);
    expect(fitsTakeOn("quick", "medium")).toBe(false);
    expect(fitsTakeOn("quick", "large")).toBe(false);
  });

  it("shows a session Small and Medium tasks", () => {
    expect(fitsTakeOn("session", "medium")).toBe(true);
    expect(fitsTakeOn("session", "large")).toBe(false);
  });

  it("shows a big chunk everything, including whole milestones", () => {
    expect(fitsTakeOn("big", "large")).toBe(true);
    expect(offersWholeMilestones("big")).toBe(true);
    expect(offersWholeMilestones("session")).toBe(false);
  });

  it("keeps estimates within the repo's largest", () => {
    expect(tierAllowed("medium", "medium")).toBe(true);
    expect(tierAllowed("large", "medium")).toBe(false);
  });
});

describe("the 48-hour lock", () => {
  const adoption = { status: "active" as const, expiresAt: lockExpiry(t0) };

  it("runs 48 hours from adoption", () => {
    expect(LOCK_HOURS).toBe(48);
    expect(lockExpiry(t0).toISOString()).toBe(at(48).toISOString());
  });

  it("holds until expires_at and lapses on read after it, with no expiry job", () => {
    expect(isHeld(adoption, at(0))).toBe(true);
    expect(isHeld(adoption, at(47.99))).toBe(true);
    expect(isHeld(adoption, at(48))).toBe(false);
    expect(isHeld(adoption, at(72))).toBe(false);
  });

  it("holds past 48 hours while a linked PR is open", () => {
    expect(isHeld(adoption, at(72), true)).toBe(true);
  });

  it("doesn't hold once the adoption was released", () => {
    expect(isHeld({ ...adoption, status: "released" }, at(1))).toBe(false);
  });

  it("says how long is left in plain words", () => {
    expect(timeLeft(lockExpiry(t0), at(0.01))).toBe("48 hours");
    expect(timeLeft(lockExpiry(t0), at(46))).toBe("2 hours");
    expect(timeLeft(lockExpiry(t0), at(47))).toBe("60 minutes");
    expect(timeLeft(lockExpiry(t0), at(49))).toBe("1 minute");
  });

  it("reads an adopted task as open again once the lock lapses", () => {
    expect(effectiveTaskStatus("adopted", adoption, at(10))).toBe("adopted");
    expect(effectiveTaskStatus("adopted", adoption, at(49))).toBe("open");
    expect(effectiveTaskStatus("adopted", null, at(1))).toBe("open");
    expect(effectiveTaskStatus("merged", null, at(1))).toBe("merged");
    expect(effectiveTaskStatus("in_review", adoption, at(80), true)).toBe("in_review");
  });
});

// ---------- adoption rules ----------

const dev = (id: number, over: Partial<AdoptActor> = {}): AdoptActor => ({
  id,
  isMainAdmin: false,
  isOrgOwner: false,
  blocked: false,
  profile: "developer",
  ...over,
});

const OWNER = 1;
const alice = dev(2);
const bob = dev(3);
const guided = dev(4, { profile: "guided" });

let nextId = 100;
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: nextId++,
  title: "A task",
  ownerId: OWNER,
  sizeTier: "small",
  status: "open",
  milestoneId: null,
  position: null,
  developersOnly: false,
  holder: null,
  hasOpenPr: false,
  ...over,
});

const milestoneTasks = (n: number, over: (i: number) => Partial<TaskView> = () => ({})) =>
  Array.from({ length: n }, (_, i) => task({ milestoneId: 9, position: i + 1, title: `Task ${i + 1}`, ...over(i) }));

const heldBy = (userId: number, milestoneId: number | null = null) => ({
  userId,
  handle: `user${userId}`,
  milestoneId,
  expiresAt: at(48),
});

describe("adopting a single task", () => {
  it("is open to anyone signed in with a profile", () => {
    expect(canAdoptTask(alice, task(), { projectOpen: true })).toEqual({ ok: true });
    expect(canAdoptTask(guided, task(), { projectOpen: true }).ok).toBe(true);
  });

  it("isn't for blocked people or people who haven't picked a profile", () => {
    expect(canAdoptTask(dev(5, { blocked: true }), task(), { projectOpen: true }).ok).toBe(false);
    expect(canAdoptTask(dev(6, { profile: null }), task(), { projectOpen: true }).ok).toBe(false);
  });

  it("isn't for the task's owner, who reviews it", () => {
    expect(canAdoptTask(dev(OWNER), task(), { projectOpen: true })).toEqual({
      ok: false,
      reason: expect.stringMatching(/your own work/),
    });
  });

  it("tells the owner who holds their task, rather than 'your own work'", () => {
    const r = canAdoptTask(dev(OWNER), task({ status: "adopted", holder: heldBy(alice.id) }), { projectOpen: true });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/@user2 has taken this on/) });
  });

  it("is blocked while someone else holds the lock", () => {
    const r = canAdoptTask(bob, task({ status: "adopted", holder: heldBy(alice.id) }), { projectOpen: true });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/@user2 has taken this on/) });
  });

  it("tells you when you already hold it", () => {
    const r = canAdoptTask(alice, task({ status: "adopted", holder: heldBy(alice.id) }), { projectOpen: true });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/already taken this on/) });
  });

  it("isn't possible on merged, closed or in-review tasks, or in a closed project", () => {
    for (const status of ["merged", "closed", "in_review", "changes_requested"] as const) {
      expect(canAdoptTask(alice, task({ status }), { projectOpen: true }).ok).toBe(false);
    }
    expect(canAdoptTask(alice, task(), { projectOpen: false }).ok).toBe(false);
  });

  it("keeps developers-only tasks away from the Guided profile", () => {
    const t = task({ developersOnly: true });
    expect(canAdoptTask(alice, t, { projectOpen: true }).ok).toBe(true);
    expect(canAdoptTask(guided, t, { projectOpen: true }).ok).toBe(false);
  });
});

describe("tasks inside a milestone go in order", () => {
  it("only lets the milestone's next task be adopted on its own", () => {
    const tasks = milestoneTasks(3);
    expect(canAdoptTask(alice, tasks[0], { projectOpen: true, milestoneTasks: tasks }).ok).toBe(true);
    const r = canAdoptTask(alice, tasks[2], { projectOpen: true, milestoneTasks: tasks });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/Task 1 .*comes first/) });
  });

  it("marks later tasks as waiting their turn, for every viewer", () => {
    const tasks = milestoneTasks(3);
    expect(tasks.map((t) => waitsItsTurn(t, tasks))).toEqual([false, true, true]);
    expect(waitsItsTurn(task(), undefined)).toBe(false);
  });

  it("moves on once the earlier tasks are merged or closed", () => {
    const tasks = milestoneTasks(3, (i) => ({ status: i === 0 ? "merged" : i === 1 ? "closed" : "open" }));
    expect(nextTaskInMilestone(tasks)?.position).toBe(3);
    expect(canAdoptTask(alice, tasks[2], { projectOpen: true, milestoneTasks: tasks }).ok).toBe(true);
  });

  it("keeps later tasks blocked while the next one is taken", () => {
    const tasks = milestoneTasks(2, (i) => (i === 0 ? { status: "adopted", holder: heldBy(alice.id) } : {}));
    expect(canAdoptTask(bob, tasks[1], { projectOpen: true, milestoneTasks: tasks }).ok).toBe(false);
  });
});

describe("adopting a whole milestone", () => {
  it("takes every open task", () => {
    const tasks = milestoneTasks(3, (i) => (i === 0 ? { status: "merged" } : {}));
    const r = canAdoptMilestone(alice, { ownerId: OWNER, projectOpen: true, tasks });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.taskIds).toEqual([tasks[1].id, tasks[2].id]);
  });

  it("is blocked once anyone holds one of its tasks", () => {
    const tasks = milestoneTasks(3, (i) => (i === 0 ? { status: "adopted", holder: heldBy(alice.id) } : {}));
    expect(canAdoptMilestone(bob, { ownerId: OWNER, projectOpen: true, tasks }).ok).toBe(false);
  });

  it("then blocks adopting any of its tasks again", () => {
    const tasks = milestoneTasks(3, () => ({ status: "adopted", holder: heldBy(alice.id, 9) }));
    for (const t of tasks) {
      expect(canAdoptTask(bob, t, { projectOpen: true, milestoneTasks: tasks }).ok).toBe(false);
    }
    expect(canAdoptMilestone(bob, { ownerId: OWNER, projectOpen: true, tasks }).ok).toBe(false);
  });

  it("isn't for the owner, and needs something left to take", () => {
    const tasks = milestoneTasks(2);
    expect(canAdoptMilestone(dev(OWNER), { ownerId: OWNER, projectOpen: true, tasks }).ok).toBe(false);
    const done = milestoneTasks(2, () => ({ status: "merged" }));
    expect(canAdoptMilestone(alice, { ownerId: OWNER, projectOpen: true, tasks: done }).ok).toBe(false);
  });

  it("isn't open to Guided users when a task is marked for developers", () => {
    const tasks = milestoneTasks(2, (i) => ({ developersOnly: i === 1 }));
    expect(canAdoptMilestone(guided, { ownerId: OWNER, projectOpen: true, tasks }).ok).toBe(false);
    expect(canAdoptMilestone(alice, { ownerId: OWNER, projectOpen: true, tasks }).ok).toBe(true);
  });
});

describe("handing back", () => {
  it("works any time the contributor has no open PR", () => {
    expect(canHandBack(alice, { holderId: alice.id, hasOpenPr: false })).toEqual({ ok: true });
  });

  it("waits while one of their PRs is open", () => {
    expect(canHandBack(alice, { holderId: alice.id, hasOpenPr: true }).ok).toBe(false);
  });

  it("is only for the person holding the work", () => {
    expect(canHandBack(bob, { holderId: alice.id, hasOpenPr: false }).ok).toBe(false);
  });
});

describe("milestone status", () => {
  it("is open, then in progress, then done when every task is merged", () => {
    expect(milestoneStatus([{ status: "open" }, { status: "open" }])).toBe("open");
    expect(milestoneStatus([{ status: "adopted" }, { status: "open" }])).toBe("in_progress");
    expect(milestoneStatus([{ status: "merged" }, { status: "open" }])).toBe("in_progress");
    expect(milestoneStatus([{ status: "merged" }, { status: "closed" }])).toBe("done");
    expect(milestoneStatus([])).toBe("open");
  });
});

// ---------- the board ----------

describe("filterBoard", () => {
  const board: BoardData = {
    projects: [
      {
        id: 1,
        title: "Uploader",
        milestones: [
          { id: 9, title: "M1", position: 1, tasks: milestoneTasks(2, (i) => ({ sizeTier: i === 0 ? "small" : "large" })) },
          { id: 10, title: "M2", position: 2, tasks: [task({ milestoneId: 10, position: 1, sizeTier: "medium" })] },
        ],
      },
    ],
    singles: [task({ sizeTier: "small" }), task({ sizeTier: "medium" }), task({ sizeTier: "small", status: "merged" })],
  };

  it("shows someone who picked a quick run only Small tasks", () => {
    const view = filterBoard(board, "quick");
    const tiers = [
      ...view.projects.flatMap((p) => p.milestones.flatMap((m) => m.tasks.map((t) => t.sizeTier))),
      ...view.singles.map((t) => t.sizeTier),
    ];
    expect(tiers.length).toBeGreaterThan(0);
    expect(new Set(tiers)).toEqual(new Set(["small"]));
  });

  it("drops milestones with nothing that fits, and finished work", () => {
    const view = filterBoard(board, "quick");
    expect(view.projects[0].milestones.map((m) => m.id)).toEqual([9]);
    expect(view.singles).toHaveLength(1);
  });

  it("shows everything to a big chunk", () => {
    const view = filterBoard(board, "big");
    expect(view.projects[0].milestones.flatMap((m) => m.tasks)).toHaveLength(3);
    expect(view.singles).toHaveLength(2);
  });
});
