import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { jobs, type Job } from "./db/schema";

// Background jobs live in Postgres. The worker claims one at a time with
// FOR UPDATE SKIP LOCKED, so no separate queue service is needed.

export const MAX_ATTEMPTS = 5;

export type Logger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

export type JobHandler = (db: Db, payload: unknown, log: Logger) => Promise<void>;

/** Returns false when a job with the same dedupe key already exists. */
export async function enqueueJob(
  db: Db,
  job: { type: string; payload: unknown; dedupeKey?: string; runAfter?: Date },
): Promise<boolean> {
  const inserted = await db
    .insert(jobs)
    .values({
      type: job.type,
      payload: job.payload,
      dedupeKey: job.dedupeKey ?? null,
      ...(job.runAfter ? { runAfter: job.runAfter } : {}),
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return inserted.length > 0;
}

export async function claimNextJob(db: Db, now: Date): Promise<Job | null> {
  const next = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, now)))
    .orderBy(asc(jobs.runAfter), asc(jobs.id))
    .limit(1)
    .for("update", { skipLocked: true });

  const [claimed] = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(inArray(jobs.id, next))
    .returning();
  return claimed ?? null;
}

/** Wait before retry: 30s, 1m, 2m, 4m... capped at 30 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export async function completeJob(db: Db, id: number, now: Date): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", finishedAt: now, updatedAt: now, lastError: null })
    .where(eq(jobs.id, id));
}

export async function failJob(
  db: Db,
  job: Job,
  error: string,
  now: Date,
  opts: { permanent?: boolean } = {},
): Promise<void> {
  const giveUp = opts.permanent || job.attempts >= MAX_ATTEMPTS;
  await db
    .update(jobs)
    .set(
      giveUp
        ? { status: "failed", lastError: error, finishedAt: now, updatedAt: now }
        : {
            status: "queued",
            lastError: error,
            runAfter: new Date(now.getTime() + retryDelayMs(job.attempts)),
            updatedAt: now,
          },
    )
    .where(eq(jobs.id, job.id));
}

/** Jobs left "running" by a worker that stopped mid-job go back in the queue. */
export async function requeueStaleJobs(
  db: Db,
  now: Date,
  staleMs = 10 * 60_000,
): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "queued", updatedAt: now })
    .where(
      and(
        eq(jobs.status, "running"),
        lt(jobs.updatedAt, new Date(now.getTime() - staleMs)),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length;
}

/** Runs one job if one is ready. Returns whether it found one. */
export async function runNextJob(
  db: Db,
  handlers: Record<string, JobHandler>,
  log: Logger,
  now: Date = new Date(),
): Promise<boolean> {
  const job = await claimNextJob(db, now);
  if (!job) return false;

  const handler = handlers[job.type];
  if (!handler) {
    await failJob(db, job, `No handler for job type "${job.type}"`, now, {
      permanent: true,
    });
    log.error(`Job ${job.id}: no handler for type "${job.type}"`);
    return true;
  }

  try {
    await handler(db, job.payload, log);
    await completeJob(db, job.id, new Date());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(db, job, message, new Date());
    log.error(`Job ${job.id} (${job.type}) failed on attempt ${job.attempts}: ${message}`);
  }
  return true;
}

export async function recentJobs(db: Db, type: string, limit = 10): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.type, type))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit);
}
