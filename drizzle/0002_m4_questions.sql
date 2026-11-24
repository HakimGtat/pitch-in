CREATE TABLE "questions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "questions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"submission_id" integer NOT NULL,
	"github_comment_id" bigint NOT NULL,
	"body" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "questions_github_comment_id_unique" UNIQUE("github_comment_id")
);
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_submission_idx" ON "questions" USING btree ("submission_id");