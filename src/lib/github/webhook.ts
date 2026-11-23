import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client";
import { enqueueJob } from "../jobs";

export const WEBHOOK_JOB = "github_webhook";

export type GitHubWebhookJob = {
  event: string;
  deliveryId: string;
  action: string | null;
  body: unknown;
};

/** Checks GitHub's X-Hub-Signature-256 header against the App's webhook secret. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"),
  );
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Verifies a delivery and queues it for the worker. The web request stays
 * fast; all real work happens in the worker.
 */
export async function receiveWebhook(
  db: Db,
  input: {
    secret: string;
    rawBody: string;
    event: string | null;
    deliveryId: string | null;
    signature: string | null;
  },
): Promise<{ status: number; message: string }> {
  if (!input.event || !input.deliveryId) {
    return { status: 400, message: "Missing GitHub event headers" };
  }
  if (!verifyWebhookSignature(input.secret, input.rawBody, input.signature)) {
    return { status: 401, message: "Signature doesn't match" };
  }

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, message: "Body isn't JSON" };
  }

  const action =
    body && typeof body === "object" && "action" in body && typeof body.action === "string"
      ? body.action
      : null;
  const payload: GitHubWebhookJob = {
    event: input.event,
    deliveryId: input.deliveryId,
    action,
    body,
  };
  const queued = await enqueueJob(db, {
    type: WEBHOOK_JOB,
    payload,
    dedupeKey: `github:${input.deliveryId}`,
  });
  return {
    status: 202,
    message: queued ? "Queued" : "Already received",
  };
}
