import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  blockUser,
  handOverMainAdmin,
  PermissionError,
  setProfile,
  unblockUser,
} from "@/lib/admin";
import type { Db } from "@/lib/db/client";
import { auditLog, users } from "@/lib/db/schema";
import { createTestDb, insertUser } from "./helpers/db";

describe("admin actions", () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(() => reset());

  const audit = () => db.select().from(auditLog).orderBy(auditLog.id);
  const reload = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0];

  it("a block by the main admin shows up in audit_log", async () => {
    const boss = await insertUser(db, { handle: "boss", isMainAdmin: true });
    const alice = await insertUser(db, { handle: "alice" });

    await blockUser(db, boss.id, alice.id);

    expect((await reload(alice.id)).blocked).toBe(true);
    const [entry] = await audit();
    expect(entry).toMatchObject({ actorId: boss.id, action: "user.blocked", target: "alice" });
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("refuses a block from a member and writes nothing", async () => {
    const alice = await insertUser(db, { handle: "alice" });
    const bob = await insertUser(db, { handle: "bob" });

    await expect(blockUser(db, alice.id, bob.id)).rejects.toThrow(PermissionError);
    expect((await reload(bob.id)).blocked).toBe(false);
    expect(await audit()).toHaveLength(0);
  });

  it("unblocks and records it", async () => {
    const boss = await insertUser(db, { handle: "boss", isMainAdmin: true });
    const alice = await insertUser(db, { handle: "alice", blocked: true });

    await unblockUser(db, boss.id, alice.id);
    expect((await reload(alice.id)).blocked).toBe(false);
    expect((await audit()).map((a) => a.action)).toEqual(["user.unblocked"]);
  });

  it("hands over the main admin role in one step", async () => {
    const boss = await insertUser(db, { handle: "boss", isMainAdmin: true });
    const alice = await insertUser(db, { handle: "alice" });

    await handOverMainAdmin(db, boss.id, alice.id);
    expect((await reload(boss.id)).isMainAdmin).toBe(false);
    expect((await reload(alice.id)).isMainAdmin).toBe(true);
    expect((await audit())[0]).toMatchObject({
      actorId: boss.id,
      action: "main_admin.handed_over",
      details: { from: "boss", to: "alice" },
    });
  });

  it("allows only one main admin in the database", async () => {
    await insertUser(db, { handle: "boss", isMainAdmin: true });
    await expect(insertUser(db, { handle: "other", isMainAdmin: true })).rejects.toThrow();
  });

  it("records profile changes, by the person or by an admin", async () => {
    const owner = await insertUser(db, { handle: "owner", isOrgOwner: true });
    const alice = await insertUser(db, { handle: "alice", profile: null });

    await setProfile(db, alice.id, alice.id, "guided");
    await setProfile(db, owner.id, alice.id, "developer");
    expect((await reload(alice.id)).profile).toBe("developer");
    expect((await audit()).map((a) => [a.action, a.actorId])).toEqual([
      ["profile.chosen", alice.id],
      ["profile.changed", owner.id],
    ]);
  });

  it("stops a member changing someone else's profile", async () => {
    const alice = await insertUser(db, { handle: "alice" });
    const bob = await insertUser(db, { handle: "bob" });
    await expect(setProfile(db, alice.id, bob.id, "guided")).rejects.toThrow(PermissionError);
  });
});
