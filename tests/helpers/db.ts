import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

/** A real Postgres (PGlite, in memory) with the app's migrations applied. */
export async function createTestDb(): Promise<{ db: Db; reset: () => Promise<void>; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });

  return {
    db: db as unknown as Db,
    reset: async () => {
      await db.execute(
        sql`TRUNCATE audit_log, alerts, jobs, reviews, submissions, adoptions, tasks, milestones, projects, repos, users RESTART IDENTITY CASCADE`,
      );
    },
    close: () => client.close(),
  };
}

export async function insertUser(
  db: Db,
  overrides: Partial<typeof schema.users.$inferInsert> & { handle: string },
) {
  const [user] = await db
    .insert(schema.users)
    .values({
      githubId: Math.floor(Math.random() * 1_000_000_000),
      profile: "developer",
      ...overrides,
    })
    .returning();
  return user;
}
