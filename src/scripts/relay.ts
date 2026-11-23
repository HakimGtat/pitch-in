import SmeeClient from "smee-client";

// Forwards GitHub webhooks from the smee.io channel to the web app, so GitHub
// can reach a machine with no public address. Used in development and the trial.
// Anyone with the channel URL can see webhook contents (not code), so keep it private.

const source = process.env.SMEE_URL?.trim();
const target =
  process.env.RELAY_TARGET ?? "http://localhost:3000/api/github/webhooks";

if (!source) {
  console.log(
    "[relay] SMEE_URL is empty, so no webhooks will be forwarded. Create a channel at https://smee.io/new, put it in .env, and restart.",
  );
  process.exit(0);
}

const client = new SmeeClient({
  source,
  target,
  logger: {
    info: (...args: unknown[]) => console.log("[relay]", ...args),
    error: (...args: unknown[]) => console.error("[relay]", ...args),
  },
});

// smee-client logs "Forwarding <source> to <target>" itself once connected.
await client.start();

const stop = async () => {
  await client.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
