import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { auditLog, jobs, repos } from "@/lib/db/schema";
import { receiveWebhook, verifyWebhookSignature } from "@/lib/github/webhook";
import { runNextJob } from "@/lib/jobs";
import { connectRepo } from "@/lib/repos";
import { createHandlers, handlers } from "@/worker/handlers";
import { createTestDb, insertUser } from "./helpers/db";
import { fakeGitHub } from "./helpers/github";

const secret = "webhook-secret";
const sign = (body: string, key = secret) =>
  "sha256=" + createHmac("sha256", key).update(body).digest("hex");

const installBody = JSON.stringify({
  action: "created",
  installation: { id: 99, account: { login: "example-org" } },
  sender: { login: "boss" },
});

const quietLog = { info: () => {}, error: () => {} };

describe("verifyWebhookSignature", () => {
  it("accepts GitHub's signature and rejects anything else", () => {
    expect(verifyWebhookSignature(secret, installBody, sign(installBody))).toBe(true);
    expect(verifyWebhookSignature(secret, installBody + " ", sign(installBody))).toBe(false);
    expect(verifyWebhookSignature(secret, installBody, sign(installBody, "other"))).toBe(false);
    expect(verifyWebhookSignature(secret, installBody, null)).toBe(false);
    expect(verifyWebhookSignature(secret, installBody, "sha1=abc")).toBe(false);
  });
});

describe("receiving webhooks", () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(() => reset());

  const deliver = (body: string, over: Partial<Parameters<typeof receiveWebhook>[1]> = {}) =>
    receiveWebhook(db, {
      secret,
      rawBody: body,
      event: "installation",
      deliveryId: "delivery-1",
      signature: sign(body),
      ...over,
    });

  it("queues a signed delivery for the worker", async () => {
    expect(await deliver(installBody)).toEqual({ status: 202, message: "Queued" });
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({
      type: "github_webhook",
      status: "queued",
      payload: { event: "installation", action: "created", deliveryId: "delivery-1" },
    });
  });

  it("rejects a bad signature without queuing anything", async () => {
    expect((await deliver(installBody, { signature: sign(installBody, "wrong") })).status).toBe(401);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("rejects requests missing GitHub's headers", async () => {
    expect((await deliver(installBody, { event: null })).status).toBe(400);
  });

  it("ignores a repeat of the same delivery", async () => {
    await deliver(installBody);
    expect(await deliver(installBody)).toEqual({ status: 202, message: "Already received" });
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("the worker records an App installation in the audit log", async () => {
    await deliver(installBody);
    expect(await runNextJob(db, handlers, quietLog)).toBe(true);

    const [job] = await db.select().from(jobs);
    expect(job.status).toBe("done");
    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      actorId: null,
      action: "github.app_installed",
      target: "example-org",
      details: { installationId: 99, sender: "boss" },
    });
  });

  it("the worker accepts other events without failing", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    await deliver(body, { event: "ping", deliveryId: "delivery-2" });
    await runNextJob(db, handlers, quietLog);
    const [job] = await db.select().from(jobs);
    expect(job.status).toBe("done");
  });
});

describe("push webhooks", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("refresh PROJECT_BRIEF.md when a connected repo's default branch changes", async () => {
    const fake = fakeGitHub();
    fake.addRepo(42, "acme/site", { ".github/workflows/ci.yml": "x", "PROJECT_BRIEF.md": "old" }, { olive: "admin" });
    const olive = await insertUser(db, { handle: "olive" });
    await connectRepo(db, fake.gh, olive.id, 42);
    fake.world.files.get("acme/site")!["PROJECT_BRIEF.md"] = "new brief";
    const run = createHandlers({ repoGitHub: () => fake.gh });

    const send = async (ref: string, id: string) => {
      const body = JSON.stringify({ ref, repository: { id: 42, full_name: "acme/site", default_branch: "main" } });
      await receiveWebhook(db, { secret, rawBody: body, event: "push", deliveryId: id, signature: sign(body) });
      await runNextJob(db, run, quietLog);
    };

    await send("refs/heads/feature", "push-1");
    expect((await db.select().from(repos))[0].projectBrief).toBe("old");
    await send("refs/heads/main", "push-2");
    expect((await db.select().from(repos))[0].projectBrief).toBe("new brief");
  });
});
