import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@/lib/db/client";

// Applies the SQL files in ./drizzle. Runs once before the web app and worker start.

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  // node-postgres and PGlite share the Db type; the migrator wants the concrete one.
  await migrate(db as Parameters<typeof migrate>[0], {
    migrationsFolder: process.env.MIGRATIONS_DIR ?? "./drizzle",
  });
  await pool.end();
  console.log("[migrate] Database is up to date");
}

main().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
