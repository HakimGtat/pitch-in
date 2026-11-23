import { desc, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { auditLog, users } from "./db/schema";

export async function writeAudit(
  db: Db,
  entry: {
    actorId: number | null;
    action: string;
    target?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    target: entry.target ?? null,
    details: entry.details ?? null,
  });
}

export async function recentAudit(db: Db, limit = 50) {
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      target: auditLog.target,
      details: auditLog.details,
      createdAt: auditLog.createdAt,
      actorHandle: users.handle,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}
