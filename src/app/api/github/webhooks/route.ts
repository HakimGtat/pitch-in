import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { receiveWebhook } from "@/lib/github/webhook";

export const dynamic = "force-dynamic";

/** GitHub App webhooks arrive here (through the smee relay during the trial). */
export async function POST(request: Request) {
  const config = getConfig();
  if (!config.githubApp) {
    return NextResponse.json({ message: "The GitHub App isn't set up yet" }, { status: 503 });
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const result = await receiveWebhook(getDb(), {
    secret: config.githubApp.webhookSecret,
    rawBody: await request.text(),
    event,
    deliveryId,
    signature: request.headers.get("x-hub-signature-256"),
  });

  const line = `[webhook] ${event ?? "?"} ${deliveryId ?? "?"}: ${result.status} ${result.message}`;
  if (result.status >= 400) console.warn(line);
  else console.log(line);

  return NextResponse.json({ message: result.message }, { status: result.status });
}
