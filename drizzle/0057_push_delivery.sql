ALTER TYPE "public"."activity_action" ADD VALUE 'repo_policy.set';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'repo_policy';--> statement-breakpoint
ALTER TABLE "export" ADD COLUMN "pushed_commit_sha" text;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_pushed_commit_sha" CHECK ("export"."pushed_commit_sha" is null or ("export"."target_kind" = 'github_push' and "export"."status" = 'done' and "export"."pushed_commit_sha" ~ '^[0-9a-f]{40}$'));