ALTER TYPE "public"."activity_action" ADD VALUE 'intake.repo_read';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'connection.created';--> statement-breakpoint
ALTER TABLE "intake" ADD COLUMN "repo_url" text;--> statement-breakpoint
ALTER TABLE "intake" ADD COLUMN "repo_commit_sha" text;--> statement-breakpoint
ALTER TABLE "intake" ADD COLUMN "repo_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_repo_read_complete" CHECK (("intake"."repo_url" is null and "intake"."repo_commit_sha" is null and "intake"."repo_read_at" is null) or ("intake"."repo_url" is not null and "intake"."repo_commit_sha" is not null and "intake"."repo_read_at" is not null));