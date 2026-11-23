import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

// Shared type so the same code runs on node-postgres (app) and PGlite (tests).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

const globalForDb = globalThis as unknown as { pitchInDb?: Db };

/** One pool per server process (survives hot reloads in development). */
export function getDb(): Db {
  if (!globalForDb.pitchInDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.pitchInDb = createDb(url).db;
  }
  return globalForDb.pitchInDb;
}
