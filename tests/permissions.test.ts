import { describe, expect, it } from "vitest";
import {
  canBlock,
  canChangeProfile,
  canChangeRepoSettings,
  canCloseOrRelease,
  canConnectRepo,
  canManageOwnWork,
  canRemoveRepo,
  canHandOverMainAdmin,
  canPostTask,
  canReviewTask,
  canUnblock,
  canViewAdmin,
  isAdmin,
  type Actor,
} from "@/lib/permissions";

let nextId = 1;
const person = (over: Partial<Actor> = {}): Actor => ({
  id: nextId++,
  isMainAdmin: false,
  isOrgOwner: false,
  blocked: false,
  ...over,
});

const mainAdmin = person({ isMainAdmin: true });
const owner = person({ isOrgOwner: true });
const owner2 = person({ isOrgOwner: true });
const member = person();
const member2 = person();

describe("admins", () => {
  it("are the main admin and GitHub org owners", () => {
    expect(isAdmin(mainAdmin)).toBe(true);
    expect(isAdmin(owner)).toBe(true);
    expect(isAdmin(member)).toBe(false);
  });

  it("lose admin powers while blocked", () => {
    expect(isAdmin(person({ isOrgOwner: true, blocked: true }))).toBe(false);
  });

  it("are the only ones who can open the admin screen", () => {
    expect(canViewAdmin(owner).ok).toBe(true);
    expect(canViewAdmin(member).ok).toBe(false);
  });
});

describe("blocking", () => {
  it("lets the main admin block a member", () => {
    expect(canBlock(mainAdmin, member)).toEqual({ ok: true });
  });

  it("lets an org owner block a member", () => {
    expect(canBlock(owner, member).ok).toBe(true);
  });

  it("stops members blocking anyone", () => {
    expect(canBlock(member, member2).ok).toBe(false);
  });

  it("stops anyone blocking themselves", () => {
    expect(canBlock(owner, owner).ok).toBe(false);
  });

  it("never blocks the main admin", () => {
    expect(canBlock(owner, mainAdmin).ok).toBe(false);
  });

  it("only lets the main admin block an org owner", () => {
    expect(canBlock(owner, owner2).ok).toBe(false);
    expect(canBlock(mainAdmin, owner).ok).toBe(true);
  });

  it("refuses to block someone already blocked", () => {
    expect(canBlock(mainAdmin, person({ blocked: true })).ok).toBe(false);
  });

  it("only unblocks people who are blocked", () => {
    const blocked = person({ blocked: true });
    expect(canUnblock(owner, blocked).ok).toBe(true);
    expect(canUnblock(owner, member).ok).toBe(false);
    expect(canUnblock(member, blocked).ok).toBe(false);
  });

  it("only lets the main admin unblock an org owner", () => {
    const blockedOwner = person({ isOrgOwner: true, blocked: true });
    expect(canUnblock(owner, blockedOwner).ok).toBe(false);
    expect(canUnblock(mainAdmin, blockedOwner).ok).toBe(true);
  });
});

describe("handing over the main admin role", () => {
  it("is only for the current main admin", () => {
    expect(canHandOverMainAdmin(mainAdmin, member).ok).toBe(true);
    expect(canHandOverMainAdmin(owner, member).ok).toBe(false);
  });

  it("can't go to yourself or to a blocked person", () => {
    expect(canHandOverMainAdmin(mainAdmin, mainAdmin).ok).toBe(false);
    expect(canHandOverMainAdmin(mainAdmin, person({ blocked: true })).ok).toBe(false);
  });
});

describe("profiles", () => {
  it("can be switched by the person or an admin", () => {
    expect(canChangeProfile(member, member).ok).toBe(true);
    expect(canChangeProfile(owner, member).ok).toBe(true);
    expect(canChangeProfile(member, member2).ok).toBe(false);
  });
});

describe("posting and reviewing follow GitHub", () => {
  const write = { permission: "write" as const };
  const read = { permission: "read" as const };

  it("posting needs write access only, with no ai-team requirement (Milestone 2)", () => {
    expect(canPostTask(member, write).ok).toBe(true);
    expect(canPostTask(member, { permission: "maintain" }).ok).toBe(true);
    expect(canPostTask(member, { permission: "admin" }).ok).toBe(true);
    expect(canPostTask(member, read).ok).toBe(false);
    expect(canPostTask(member, { permission: "triage" }).ok).toBe(false);
    expect(canPostTask(member, { permission: "none" }).ok).toBe(false);
  });

  it("being a site admin doesn't let you post without GitHub access", () => {
    expect(canPostTask(mainAdmin, { permission: "none" }).ok).toBe(false);
  });

  it("blocked people can't post", () => {
    expect(canPostTask(person({ blocked: true }), write).ok).toBe(false);
  });

  it("only the task owner reviews, and only with GitHub access", () => {
    const task = { ownerId: member.id };
    expect(canReviewTask(member, task, write).ok).toBe(true);
    expect(canReviewTask(member2, task, write).ok).toBe(false);
    expect(canReviewTask(member, task, read).ok).toBe(false);
  });
});

describe("repos follow GitHub", () => {
  it("are connected by repo admins only", () => {
    expect(canConnectRepo(member, { permission: "admin" }).ok).toBe(true);
    expect(canConnectRepo(member, { permission: "write" }).ok).toBe(false);
    expect(canConnectRepo(mainAdmin, { permission: "write" }).ok).toBe(false);
    expect(canConnectRepo(person({ blocked: true }), { permission: "admin" }).ok).toBe(false);
  });

  it("have settings that repo admins and site admins can change", () => {
    expect(canChangeRepoSettings(member, { permission: "admin" }).ok).toBe(true);
    expect(canChangeRepoSettings(owner, { permission: "read" }).ok).toBe(true);
    expect(canChangeRepoSettings(member, { permission: "write" }).ok).toBe(false);
  });

  it("are removed by site admins only", () => {
    expect(canRemoveRepo(owner).ok).toBe(true);
    expect(canRemoveRepo(member).ok).toBe(false);
  });
});

describe("tasks and projects", () => {
  const mine = { ownerId: member.id };
  const write = { permission: "write" as const };

  it("are edited and added to by their owner with write access", () => {
    expect(canManageOwnWork(member, mine, write).ok).toBe(true);
    expect(canManageOwnWork(member, mine, { permission: "read" }).ok).toBe(false);
    expect(canManageOwnWork(member2, mine, write).ok).toBe(false);
    expect(canManageOwnWork(owner, mine, write).ok).toBe(false);
  });

  it("are closed and released by their owner or an admin", () => {
    expect(canCloseOrRelease(member, mine).ok).toBe(true);
    expect(canCloseOrRelease(owner, mine).ok).toBe(true);
    expect(canCloseOrRelease(member2, mine).ok).toBe(false);
    expect(canCloseOrRelease(person({ blocked: true, id: member.id }), mine).ok).toBe(false);
  });
});
