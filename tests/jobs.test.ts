import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import {
  claimNextJob,
  enqueueJob,
  MAX_ATTEMPTS,
  requeueStaleJobs,
  retryDelayMs,
  runNextJob,
} from "@/lib/jobs";
import { createTestDb } from "./helpers/db";

const quietLog = { info: () => {}, error: () => {} };
const now = new Date("2026-11-23T12:00:00Z");

describe("job queue", () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(() => reset());

  const only = async () => (await db.select().from(jobs))[0];

  it("claims jobs oldest first and skips ones scheduled for later", async () => {
    await enqueueJob(db, { type: "a", payload: 1, runAfter: new Date(now.getTime() - 2000) });
    await enqueueJob(db, { type: "b", payload: 2, runAfter: new Date(now.getTime() + 60_000) });
    await enqueueJob(db, { type: "c", payload: 3, runAfter: new Date(now.getTime() - 1000) });

    expect((await claimNextJob(db, now))?.type).toBe("a");
    expect((await claimNextJob(db, now))?.type).toBe("c");
    expect(await claimNextJob(db, now)).toBeNull();
  });

  it("marks a job done when its handler succeeds", async () => {
    await enqueueJob(db, { type: "ok", payload: {}, runAfter: now });
    await runNextJob(db, { ok: async () => {} }, quietLog, now);
    expect(await only()).toMatchObject({ status: "done", attempts: 1 });
  });

  it("retries a failing job later, then gives up after the last attempt", async () => {
    await enqueueJob(db, { type: "boom", payload: {}, runAfter: now });
    const boom = { boom: async () => { throw new Error("GitHub is down"); } };

    await runNextJob(db, boom, quietLog, now);
    const first = await only();
    expect(first).toMatchObject({ status: "queued", attempts: 1, lastError: "GitHub is down" });
    expect(first.runAfter.getTime()).toBeGreaterThan(now.getTime());

    await db.update(jobs).set({ attempts: MAX_ATTEMPTS - 1, runAfter: now }).where(eq(jobs.id, first.id));
    await runNextJob(db, boom, quietLog, now);
    expect(await only()).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("fails a job with no handler straight away", async () => {
    await enqueueJob(db, { type: "unknown", payload: {}, runAfter: now });
    await runNextJob(db, {}, quietLog, now);
    expect((await only()).status).toBe("failed");
  });

  it("backs off between retries, up to 30 minutes", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(30 * 60_000);
  });

  it("puts jobs a stopped worker left running back in the queue", async () => {
    await enqueueJob(db, { type: "x", payload: {}, runAfter: now });
    await claimNextJob(db, now);
    expect(await requeueStaleJobs(db, new Date(now.getTime() + 5 * 60_000))).toBe(0);
    expect(await requeueStaleJobs(db, new Date(now.getTime() + 11 * 60_000))).toBe(1);
    expect((await only()).status).toBe("queued");
  });
});
