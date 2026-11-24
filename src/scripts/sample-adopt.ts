import { and, eq } from "drizzle-orm";
import { adoptMilestone, handBack } from "@/lib/adoption";
import { checkBrief, emptyBrief, type BriefDraft } from "@/lib/brief";
import { createDb } from "@/lib/db/client";
import { promptForTask } from "@/lib/start";
import { loadTaskView } from "@/lib/views";
import { adoptions, repos, tasks, users } from "@/lib/db/schema";

// SAMPLE DATA helper for live checks with one GitHub account. It creates a
// clearly labeled sample user (never a real GitHub account) and acts as them:
//
//   npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data adopt <milestoneId>
//   npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data hand-back <milestoneId>
//   npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data post-task <repoId>
//   npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data start-link <taskId>
//
// adopt and hand-back go through the same code the site uses. start-link
// prints the Start in Claude link the sample user's task page would show, built
// by the same code, for a task they hold. post-task writes
// a sample single task owned by the sample user straight to the database,
// skipping the GitHub write-access check (the sample user has no GitHub
// account), so a real account can take it on and try Start in Claude.
//
// Not part of the Docker image. Don't run it against a real company install.

// GitHub ids are positive, so a negative one can't clash with a real person.
// -1 is taken by the blocked sample member from Milestone 1's live check.
const SAMPLE_GITHUB_ID = -2;

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--sample-data")) {
    console.error("This creates a sample user (sample data). Pass --sample-data to confirm.");
    process.exit(1);
  }
  const [command, idArg] = args.filter((a) => a !== "--sample-data");
  const id = Number(idArg);
  if (!["adopt", "hand-back", "post-task", "start-link"].includes(command) || !Number.isInteger(id)) {
    console.error("Usage: sample-adopt.ts --sample-data adopt|hand-back <milestoneId> | post-task <repoId> | start-link <taskId>");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);

  try {
    let [sample] = await db.select().from(users).where(eq(users.githubId, SAMPLE_GITHUB_ID));
    if (!sample) {
      [sample] = await db
        .insert(users)
        .values({
          githubId: SAMPLE_GITHUB_ID,
          handle: "sample-contributor",
          name: "Sample contributor (sample data)",
          profile: "developer",
          takeOn: "big",
        })
        .returning();
      console.log(`Created @${sample.handle} (sample data, not a real GitHub account).`);
    }

    if (command === "post-task") {
      const [repo] = await db.select().from(repos).where(eq(repos.id, id));
      if (!repo) throw new Error("No connected repo with that id.");
      const draft: BriefDraft = {
        title: "Add a readingTime helper (sample data)",
        kind: "code",
        sizeTier: "small",
        allowedPaths: ["src/readingTime.js", "src/index.js", "tests/readingTime.test.js", "README.md"],
        brief: {
          ...emptyBrief(),
          goal: "A readingTime(text) helper returns whole minutes to read text at 200 words a minute.",
          files: ["src/wordCount.js", "src/index.js", "tests/wordCount.test.js", "README.md"],
          acceptance: [
            "readingTime is exported from src/index.js",
            "readingTime(\"\") returns 0 and 201 words return 2",
            "README.md has a one-line example",
            "All tests pass",
          ],
          testCommand: "npm test",
          constraints: "No new dependencies; reuse wordCount.",
        },
      };
      const check = checkBrief(draft, { repoFullName: repo.fullName, settings: repo.settings, tree: null });
      if (check.errors.length) throw new Error(check.errors.map((e) => e.message).join("\n"));
      const [task] = await db
        .insert(tasks)
        .values({
          repoId: repo.id,
          ownerId: sample.id,
          title: draft.title,
          kind: draft.kind,
          brief: draft.brief,
          briefMd: check.markdown,
          sizeTier: "small",
          allowedPaths: draft.allowedPaths,
        })
        .returning({ id: tasks.id });
      console.log(`@${sample.handle} posted PI-${task.id} on ${repo.fullName} (sample data).`);
    } else if (command === "start-link") {
      const now = new Date();
      const task = await loadTaskView(db, id, now);
      if (!task) throw new Error("No task with that id.");
      if (task.holder?.userId !== sample.id) throw new Error("The sample user doesn't hold that task. Adopt its milestone first.");
      const { url, long } = await promptForTask(db, task, now);
      console.log(url);
      console.error(`${url.length} characters${long ? ", longer than any link tested so far" : ""}.`);
    } else if (command === "adopt") {
      const ids = await adoptMilestone(db, sample.id, id);
      console.log(`@${sample.handle} adopted milestone ${id}: tasks ${ids.map((i) => `PI-${i}`).join(", ")}.`);
    } else {
      const [held] = await db
        .select({ taskId: adoptions.taskId })
        .from(adoptions)
        .where(
          and(eq(adoptions.milestoneId, id), eq(adoptions.userId, sample.id), eq(adoptions.status, "active")),
        );
      if (!held) throw new Error("The sample user doesn't hold that milestone.");
      const ids = await handBack(db, sample.id, held.taskId);
      console.log(`@${sample.handle} handed back tasks ${ids.map((i) => `PI-${i}`).join(", ")}.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
