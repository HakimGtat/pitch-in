CREATE TYPE "public"."milestone_status" AS ENUM('open', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('open', 'done', 'closed');--> statement-breakpoint
CREATE TYPE "public"."take_on" AS ENUM('quick', 'session', 'big');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('code', 'other');--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "milestones_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" integer NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" "milestone_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "projects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" "project_status" DEFAULT 'open' NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adoptions" ADD COLUMN "milestone_id" integer;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "milestone_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "brief" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "take_on" "take_on" DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_position" ON "milestones" USING btree ("project_id","position");--> statement-breakpoint
ALTER TABLE "adoptions" ADD CONSTRAINT "adoptions_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_milestone_idx" ON "tasks" USING btree ("milestone_id","position");