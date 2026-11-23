import { eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { users } from "../db/schema";

export type TeamState = "active" | "pending" | "none";

export type GitHubIdentity = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
};

/** The GitHub calls sign-in needs. The real one lives in lib/github/app.ts; tests use a fake. */
export interface SignInGitHub {
  /** Swap the OAuth code from GitHub's redirect for the person's identity. */
  identify(code: string): Promise<GitHubIdentity>;
  teamMembership(login: string, teamSlug: string): Promise<TeamState>;
  isOrgOwner(login: string): Promise<boolean>;
}

export type SignInSettings = {
  signInTeam: string;
  aiTeam: string;
  mainAdminLogin: string;
};

export type SignInRefusal = "not_in_team" | "invite_pending" | "blocked";

export type SignInResult =
  | { ok: true; userId: number; needsWelcome: boolean }
  | { ok: false; reason: SignInRefusal; login: string };

/** Sign-in rule: GitHub team membership first, then the site's block list. */
export function decideSignIn(input: {
  signInTeam: TeamState;
  blocked: boolean;
}): { ok: true } | { ok: false; reason: SignInRefusal } {
  if (input.signInTeam === "pending")
    return { ok: false, reason: "invite_pending" };
  if (input.signInTeam !== "active") return { ok: false, reason: "not_in_team" };
  if (input.blocked) return { ok: false, reason: "blocked" };
  return { ok: true };
}

/**
 * MAIN_ADMIN_GITHUB_LOGIN only applies while nobody holds the role. After the
 * first seed (or a handover in the admin screen) the env var is ignored.
 */
export function shouldSeedMainAdmin(input: {
  login: string;
  mainAdminLogin: string;
  mainAdminExists: boolean;
}): boolean {
  return (
    !input.mainAdminExists &&
    input.login.toLowerCase() === input.mainAdminLogin.trim().toLowerCase()
  );
}

/**
 * Runs after GitHub redirects back with a code. Checks team membership fresh
 * from GitHub on every sign-in and records what it found.
 */
export async function completeSignIn(
  db: Db,
  github: SignInGitHub,
  code: string,
  settings: SignInSettings,
  now: Date = new Date(),
): Promise<SignInResult> {
  const identity = await github.identify(code);
  const signInTeam = await github.teamMembership(
    identity.login,
    settings.signInTeam,
  );

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.githubId, identity.id));

  const decision = decideSignIn({
    signInTeam,
    blocked: existing?.blocked ?? false,
  });
  if (!decision.ok) {
    await writeAudit(db, {
      actorId: null,
      action: "signin.refused",
      target: identity.login,
      details: { reason: decision.reason, githubId: identity.id },
    });
    return { ok: false, reason: decision.reason, login: identity.login };
  }

  const inAiTeam =
    (await github.teamMembership(identity.login, settings.aiTeam)) === "active";
  const isOrgOwner = await github.isOrgOwner(identity.login);

  return db.transaction(async (tx) => {
    const fields = {
      handle: identity.login,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      inAiTeam,
      isOrgOwner,
      membershipCheckedAt: now,
      lastSignInAt: now,
      updatedAt: now,
    };

    let user;
    if (!existing) {
      [user] = await tx
        .insert(users)
        .values({ githubId: identity.id, ...fields, createdAt: now })
        .returning();
      await writeAudit(tx, {
        actorId: user.id,
        action: "user.first_sign_in",
        target: identity.login,
      });
    } else {
      [user] = await tx
        .update(users)
        .set(fields)
        .where(eq(users.id, existing.id))
        .returning();
      // GitHub changed someone's role since their last visit: record it.
      if (existing.isOrgOwner !== isOrgOwner) {
        await writeAudit(tx, {
          actorId: null,
          action: isOrgOwner ? "role.org_owner_added" : "role.org_owner_removed",
          target: identity.login,
          details: { source: "github" },
        });
      }
      if (existing.inAiTeam !== inAiTeam) {
        await writeAudit(tx, {
          actorId: null,
          action: inAiTeam ? "role.ai_team_added" : "role.ai_team_removed",
          target: identity.login,
          details: { source: "github" },
        });
      }
    }

    const [holder] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isMainAdmin, true))
      .limit(1);
    if (
      shouldSeedMainAdmin({
        login: identity.login,
        mainAdminLogin: settings.mainAdminLogin,
        mainAdminExists: Boolean(holder),
      })
    ) {
      await tx
        .update(users)
        .set({ isMainAdmin: true })
        .where(eq(users.id, user.id));
      await writeAudit(tx, {
        actorId: null,
        action: "main_admin.seeded",
        target: identity.login,
        details: { source: "MAIN_ADMIN_GITHUB_LOGIN" },
      });
    }

    return { ok: true, userId: user.id, needsWelcome: user.profile === null };
  });
}
