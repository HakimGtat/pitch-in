import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// The whole data model from plan.md. Milestone 1 created users, jobs and
// audit_log plus the tables later milestones fill in; Milestone 2 adds projects,
// milestones, the take-on choice and the structured task brief.

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const profileEnum = pgEnum("profile", ["developer", "guided"]);
export const sizeTierEnum = pgEnum("size_tier", ["small", "medium", "large"]);
// "How much do you want to take on?": a quick run, a session, a big chunk.
export const takeOnEnum = pgEnum("take_on", ["quick", "session", "big"]);
export const taskKindEnum = pgEnum("task_kind", ["code", "other"]);
export const projectStatusEnum = pgEnum("project_status", ["open", "done", "closed"]);
export const milestoneStatusEnum = pgEnum("milestone_status", ["open", "in_progress", "done"]);
export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "adopted",
  "in_review",
  "changes_requested",
  "merged",
  "closed",
]);
export const adoptionStatusEnum = pgEnum("adoption_status", [
  "active",
  "released",
  "expired",
  "completed",
]);
export const submissionStatusEnum = pgEnum("submission_status", [
  "checking",
  "checks_failed",
  "in_review",
  "changes_requested",
  "merged",
  "rejected",
  "closed",
]);
export const reviewDecisionEnum = pgEnum("review_decision", [
  "changes_requested",
  "rejected",
]);
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);
export const alertKindEnum = pgEnum("alert_kind", [
  "unreviewed_merge",
  "direct_push",
]);

export const users = pgTable(
  "users",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
    // GitHub login. Kept in sync at every sign-in because logins can be renamed.
    handle: text("handle").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    // Null until the person answers the welcome question.
    profile: profileEnum("profile"),
    // Only a default for the board filter. Never a permission.
    takeOn: takeOnEnum("take_on").notNull().default("session"),
    isMainAdmin: boolean("is_main_admin").notNull().default(false),
    // Copied from GitHub at each sign-in. GitHub stays the source of truth.
    isOrgOwner: boolean("is_org_owner").notNull().default(false),
    inAiTeam: boolean("in_ai_team").notNull().default(false),
    blocked: boolean("blocked").notNull().default(false),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    membershipCheckedAt: timestamp("membership_checked_at", {
      withTimezone: true,
    }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one main admin at a time.
    uniqueIndex("users_one_main_admin")
      .on(t.isMainAdmin)
      .where(sql`${t.isMainAdmin} = true`),
  ],
);

export type RepoSettings = {
  largestTier: "small" | "medium" | "large";
  offLimitsPaths: string[];
  sizeCapIgnore: string[];
};

export const repos = pgTable("repos", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  fullName: text("full_name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  projectBrief: text("project_brief"),
  projectBriefSha: text("project_brief_sha"),
  projectBriefUpdatedAt: timestamp("project_brief_updated_at", {
    withTimezone: true,
  }),
  hasCi: boolean("has_ci").notNull().default(false),
  // When PROJECT_BRIEF.md and CI were last read from GitHub.
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
  settings: jsonb("settings")
    .$type<RepoSettings>()
    .notNull()
    .default({ largestTier: "large", offLimitsPaths: [], sizeCapIgnore: [] }),
  connectedById: integer("connected_by_id").references(() => users.id),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projects = pgTable("projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repos.id),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  status: projectStatusEnum("status").notNull().default("open"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const milestones = pgTable(
  "milestones",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: milestoneStatusEnum("status").notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("milestones_project_position").on(t.projectId, t.position)],
);

/** The Task Brief fields from plan.md. Title, kind, estimate and allowed paths are columns. */
export type TaskBrief = {
  goal: string;
  /** Exact paths, five at most. A note in brackets may follow a path. */
  files: string[];
  /** Non-code tasks: the file to produce and its format. */
  output: string;
  /** Bugs: what happens now (with reproduction steps) and what should happen. */
  current: string;
  expected: string;
  acceptance: string[];
  testCommand: string;
  constraints: string;
  outOfScope: string;
  example: string;
};

export const tasks = pgTable(
  "tasks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    // Both null for a single task. A project task always has a milestone.
    projectId: integer("project_id").references(() => projects.id),
    milestoneId: integer("milestone_id").references(() => milestones.id),
    // Order inside the milestone. Null for single tasks.
    position: integer("position"),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    kind: taskKindEnum("kind").notNull().default("code"),
    brief: jsonb("brief").$type<TaskBrief>().notNull(),
    // The brief rendered as Markdown, as contributors and their agents see it.
    briefMd: text("brief_md").notNull(),
    sizeTier: sizeTierEnum("size_tier").notNull(),
    allowedPaths: text("allowed_paths").array().notNull(),
    status: taskStatusEnum("status").notNull().default("open"),
    // Set when a guided user's second try fails: the task returns for developers.
    developersOnly: boolean("developers_only").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status),
    index("tasks_milestone_idx").on(t.milestoneId, t.position),
  ],
);

export const adoptions = pgTable(
  "adoptions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    // Set when the task was taken as part of a whole milestone.
    milestoneId: integer("milestone_id").references(() => milestones.id),
    // The adopter's profile when they took it on, so the Trial panel isn't rewritten by a later switch.
    profile: profileEnum("profile"),
    adoptedAt: timestamp("adopted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The lock is free again once expires_at has passed. Computed on read.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: adoptionStatusEnum("status").notNull().default("active"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("adoptions_one_active_per_task")
      .on(t.taskId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const submissions = pgTable(
  "submissions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id),
    checkResults: jsonb("check_results"),
    usageNote: text("usage_note"),
    fixRound: integer("fix_round").notNull().default(0),
    status: submissionStatusEnum("status").notNull().default("checking"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("submissions_task_pr").on(t.taskId, t.prNumber)],
);

// A contributor's agent asking the owner on a draft PR (plan.md, "Questions for
// the owner"). Picked up from the issue_comment webhook. Answered when the PR
// closes (merged or not) or the task is reopened; nobody waits on it live.
export const questions = pgTable(
  "questions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => submissions.id),
    githubCommentId: bigint("github_comment_id", { mode: "number" }).notNull().unique(),
    // The comment text, so the owner's pages and Answer in Claude can show it.
    body: text("body").notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [index("questions_submission_idx").on(t.submissionId)],
);

export const reviews = pgTable("reviews", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  submissionId: integer("submission_id")
    .notNull()
    .references(() => submissions.id),
  reviewerId: integer("reviewer_id")
    .notNull()
    .references(() => users.id),
  decision: reviewDecisionEnum("decision").notNull(),
  // Structured items: criterion, problem, expected fix.
  comments: jsonb("comments").notNull().default([]),
  createdAt: createdAt(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Stops the same GitHub delivery being queued twice.
    dedupeKey: text("dedupe_key").unique(),
    lastError: text("last_error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_ready_idx").on(t.status, t.runAfter)],
);

export const alerts = pgTable("alerts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repos.id),
  kind: alertKindEnum("kind").notNull(),
  details: jsonb("details").notNull(),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedById: integer("resolved_by_id").references(() => users.id),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // Null when the action came from GitHub or the system, not a signed-in person.
    actorId: integer("actor_id").references(() => users.id),
    action: text("action").notNull(),
    target: text("target"),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Adoption = typeof adoptions.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type SizeTier = (typeof sizeTierEnum.enumValues)[number];
export type TakeOn = (typeof takeOnEnum.enumValues)[number];
export type TaskKind = (typeof taskKindEnum.enumValues)[number];
export type Job = typeof jobs.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
