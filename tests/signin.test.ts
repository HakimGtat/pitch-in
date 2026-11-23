import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeSignIn,
  decideSignIn,
  shouldSeedMainAdmin,
  type GitHubIdentity,
  type SignInGitHub,
  type TeamState,
} from "@/lib/auth/signin";
import { handOverMainAdmin } from "@/lib/admin";
import { auditLog, users } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { createTestDb } from "./helpers/db";

const settings = {
  signInTeam: "wishlist-users",
  aiTeam: "ai-team",
  mainAdminLogin: "Boss",
};

/** A pretend GitHub: codes map to people, and teams list their members. */
function fakeGitHub(opts: {
  people: Record<string, GitHubIdentity>;
  teams: Record<string, Record<string, TeamState>>;
  owners?: string[];
}): SignInGitHub {
  return {
    async identify(code) {
      const who = opts.people[code];
      if (!who) throw new Error("bad code");
      return who;
    },
    async teamMembership(login, team) {
      return opts.teams[team]?.[login] ?? "none";
    },
    async isOrgOwner(login) {
      return (opts.owners ?? []).includes(login);
    },
  };
}

const boss = { id: 1, login: "boss", name: "Boss", avatarUrl: null };
const alice = { id: 2, login: "alice", name: "Alice", avatarUrl: null };
const outsider = { id: 3, login: "mallory", name: null, avatarUrl: null };
const invited = { id: 4, login: "newbie", name: null, avatarUrl: null };

let github: SignInGitHub;
const world = {
  people: { boss, alice, mallory: outsider, newbie: invited } as Record<string, GitHubIdentity>,
  teams: {
    "wishlist-users": { boss: "active", alice: "active", newbie: "pending" },
    "ai-team": { alice: "active" },
  } as Record<string, Record<string, TeamState>>,
  owners: ["boss"],
};

describe("decideSignIn", () => {
  it("lets active team members in", () => {
    expect(decideSignIn({ signInTeam: "active", blocked: false })).toEqual({ ok: true });
  });
  it("refuses people outside the team, pending invites and blocked people", () => {
    expect(decideSignIn({ signInTeam: "none", blocked: false })).toEqual({ ok: false, reason: "not_in_team" });
    expect(decideSignIn({ signInTeam: "pending", blocked: false })).toEqual({ ok: false, reason: "invite_pending" });
    expect(decideSignIn({ signInTeam: "active", blocked: true })).toEqual({ ok: false, reason: "blocked" });
  });
});

describe("shouldSeedMainAdmin", () => {
  it("matches the configured login, ignoring case", () => {
    expect(shouldSeedMainAdmin({ login: "BOSS", mainAdminLogin: "boss", mainAdminExists: false })).toBe(true);
    expect(shouldSeedMainAdmin({ login: "alice", mainAdminLogin: "boss", mainAdminExists: false })).toBe(false);
  });
  it("does nothing once someone holds the role", () => {
    expect(shouldSeedMainAdmin({ login: "boss", mainAdminLogin: "boss", mainAdminExists: true })).toBe(false);
  });
});

describe("completeSignIn", () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await reset();
    github = fakeGitHub(world);
  });

  const audit = () => db.select().from(auditLog).orderBy(auditLog.id);

  it("signs in a team member and creates their account", async () => {
    const result = await completeSignIn(db, github, "alice", settings);
    expect(result).toMatchObject({ ok: true, needsWelcome: true });

    const [row] = await db.select().from(users).where(eq(users.githubId, 2));
    expect(row).toMatchObject({ handle: "alice", inAiTeam: true, isOrgOwner: false, isMainAdmin: false });
    expect(row.membershipCheckedAt).toBeInstanceOf(Date);
    expect((await audit()).map((a) => a.action)).toEqual(["user.first_sign_in"]);
  });

  it("refuses an outsider and records the attempt", async () => {
    const result = await completeSignIn(db, github, "mallory", settings);
    expect(result).toEqual({ ok: false, reason: "not_in_team", login: "mallory" });
    expect(await db.select().from(users)).toHaveLength(0);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: "signin.refused", target: "mallory", details: { reason: "not_in_team", githubId: 3 } });
  });

  it("refuses someone who hasn't accepted their team invite yet", async () => {
    const result = await completeSignIn(db, github, "newbie", settings);
    expect(result).toMatchObject({ ok: false, reason: "invite_pending" });
  });

  it("re-checks the team at every sign-in, so people who leave lose access", async () => {
    expect((await completeSignIn(db, github, "alice", settings)).ok).toBe(true);
    github = fakeGitHub({ ...world, teams: { ...world.teams, "wishlist-users": { boss: "active" } } });
    expect(await completeSignIn(db, github, "alice", settings)).toMatchObject({ ok: false, reason: "not_in_team" });
  });

  it("refuses a blocked person even though they're on the team", async () => {
    await completeSignIn(db, github, "alice", settings);
    await db.update(users).set({ blocked: true }).where(eq(users.githubId, 2));
    expect(await completeSignIn(db, github, "alice", settings)).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("makes MAIN_ADMIN_GITHUB_LOGIN the main admin on their first sign-in", async () => {
    await completeSignIn(db, github, "boss", settings);
    const [row] = await db.select().from(users).where(eq(users.githubId, 1));
    expect(row).toMatchObject({ isMainAdmin: true, isOrgOwner: true });
    expect((await audit()).map((a) => a.action)).toContain("main_admin.seeded");
  });

  it("doesn't take the role back after a handover", async () => {
    const bossResult = await completeSignIn(db, github, "boss", settings);
    const aliceResult = await completeSignIn(db, github, "alice", settings);
    if (!bossResult.ok || !aliceResult.ok) throw new Error("setup failed");
    await handOverMainAdmin(db, bossResult.userId, aliceResult.userId);

    await completeSignIn(db, github, "boss", settings);
    const rows = await db.select().from(users).where(eq(users.isMainAdmin, true));
    expect(rows.map((r) => r.handle)).toEqual(["alice"]);
  });

  it("keeps the account when someone renames their GitHub login", async () => {
    const first = await completeSignIn(db, github, "alice", settings);
    github = fakeGitHub({
      ...world,
      people: { ...world.people, alice: { ...alice, login: "alice-new" } },
      teams: { ...world.teams, "wishlist-users": { "alice-new": "active" } },
    });
    const second = await completeSignIn(db, github, "alice", settings);
    expect(second.ok && first.ok && second.userId === first.userId).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.githubId, 2));
    expect(row.handle).toBe("alice-new");
  });

  it("records role changes it picks up from GitHub", async () => {
    await completeSignIn(db, github, "alice", settings);
    github = fakeGitHub({ ...world, teams: { ...world.teams, "ai-team": {} }, owners: ["boss", "alice"] });
    await completeSignIn(db, github, "alice", settings);
    const actions = (await audit()).map((a) => a.action);
    expect(actions).toContain("role.ai_team_removed");
    expect(actions).toContain("role.org_owner_added");
  });
});
