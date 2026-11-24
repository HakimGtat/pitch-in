import { asc, eq } from "drizzle-orm";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { users, type User } from "./db/schema";
import {
  canBlock,
  canChangeProfile,
  canHandOverMainAdmin,
  canUnblock,
  type Decision,
} from "./permissions";

/** Thrown when a permission rule says no. The message is safe to show. */
export class PermissionError extends Error {}

type Profile = NonNullable<User["profile"]>;

export async function getUser(db: Db, id: number): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw new PermissionError("That person doesn't exist.");
  return user;
}

function enforce(decision: Decision): void {
  if (!decision.ok) throw new PermissionError(decision.reason);
}

export async function blockUser(
  db: Db,
  actorId: number,
  targetId: number,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const target = await getUser(tx, targetId);
    enforce(canBlock(actor, target));
    await tx
      .update(users)
      .set({ blocked: true, blockedAt: now, updatedAt: now })
      .where(eq(users.id, target.id));
    await writeAudit(tx, {
      actorId: actor.id,
      action: "user.blocked",
      target: target.handle,
    });
  });
}

export async function unblockUser(
  db: Db,
  actorId: number,
  targetId: number,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const target = await getUser(tx, targetId);
    enforce(canUnblock(actor, target));
    await tx
      .update(users)
      .set({ blocked: false, blockedAt: null, updatedAt: now })
      .where(eq(users.id, target.id));
    await writeAudit(tx, {
      actorId: actor.id,
      action: "user.unblocked",
      target: target.handle,
    });
  });
}

export async function handOverMainAdmin(
  db: Db,
  actorId: number,
  targetId: number,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const target = await getUser(tx, targetId);
    enforce(canHandOverMainAdmin(actor, target));
    // Clear first: the database allows only one main admin at a time.
    await tx
      .update(users)
      .set({ isMainAdmin: false, updatedAt: now })
      .where(eq(users.id, actor.id));
    await tx
      .update(users)
      .set({ isMainAdmin: true, updatedAt: now })
      .where(eq(users.id, target.id));
    await writeAudit(tx, {
      actorId: actor.id,
      action: "main_admin.handed_over",
      target: target.handle,
      details: { from: actor.handle, to: target.handle },
    });
  });
}

export async function setProfile(
  db: Db,
  actorId: number,
  targetId: number,
  profile: Profile,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const target = await getUser(tx, targetId);
    enforce(canChangeProfile(actor, target));
    if (target.profile === profile) return;
    await tx
      .update(users)
      .set({ profile, updatedAt: now })
      .where(eq(users.id, target.id));
    await writeAudit(tx, {
      actorId: actor.id,
      action: target.profile === null ? "profile.chosen" : "profile.changed",
      target: target.handle,
      details: { from: target.profile, to: profile },
    });
  });
}

/** "How much do you want to take on?" Only a board default, so it isn't audited. */
export async function setTakeOn(db: Db, userId: number, takeOn: User["takeOn"], now: Date = new Date()): Promise<void> {
  await db.update(users).set({ takeOn, updatedAt: now }).where(eq(users.id, userId));
}

export async function listUsers(db: Db): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.handle));
}
