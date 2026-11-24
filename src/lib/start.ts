import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { milestones, projects, repos, tasks } from "./db/schema";
import { buildPrompt, isLongLink, startInClaudeUrl } from "./prompt";
import { loadTaskViews, type FullTaskView } from "./views";

/** The Start in Claude prompt and link for one task, with its project and milestone goals. */
export async function promptForTask(db: Db, task: FullTaskView, now: Date): Promise<{ prompt: string; url: string; long: boolean }> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, task.repoId));
  const [project] = task.projectId ? await db.select().from(projects).where(eq(projects.id, task.projectId)) : [];
  const [milestone] = task.milestoneId ? await db.select().from(milestones).where(eq(milestones.id, task.milestoneId)) : [];
  const earlier = milestone
    ? (await loadTaskViews(db, eq(tasks.milestoneId, milestone.id), now))
        .filter((t) => (t.position ?? 0) < (task.position ?? 0))
        .map((t) => ({ position: t.position ?? 0, title: t.title, status: t.status }))
    : [];

  const prompt = buildPrompt({
    task: {
      id: task.id,
      kind: task.kind,
      sizeTier: task.sizeTier,
      briefMd: task.task.briefMd,
      acceptance: task.task.brief.acceptance,
      testCommand: task.task.brief.testCommand,
    },
    repo: {
      fullName: repo.fullName,
      hasProjectBrief: Boolean(repo.projectBrief),
      offLimitsPaths: repo.settings.offLimitsPaths,
    },
    project: project ? { title: project.title, goal: project.goal } : null,
    milestone: milestone ? { position: milestone.position, title: milestone.title, goal: milestone.goal, earlier } : null,
  });
  const url = startInClaudeUrl(prompt, repo.fullName);
  return { prompt, url, long: isLongLink(url) };
}
