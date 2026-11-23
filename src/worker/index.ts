import { createDb } from "@/lib/db/client";
import { requeueStaleJobs, runNextJob, type Logger } from "@/lib/jobs";
import { handlers } from "./handlers";

// The worker polls the jobs table. It never runs contributor code; from
// Milestone 3 it only reads diffs through the GitHub API.

const IDLE_POLL_MS = 2000;

const log: Logger = {
  info: (msg) => console.log(`[worker] ${msg}`),
  error: (msg) => console.error(`[worker] ${msg}`),
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const requeued = await requeueStaleJobs(db, new Date());
  if (requeued) log.info(`Put ${requeued} interrupted job(s) back in the queue`);
  log.info("Started, waiting for jobs");

  while (!stopping) {
    let didWork = false;
    try {
      didWork = await runNextJob(db, handlers, log);
    } catch (err) {
      log.error(`Polling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!didWork) await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  }

  await pool.end();
  log.info("Stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
