ALTER TABLE "export" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "export" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "export" ADD COLUMN "pr_head_ref" text;--> statement-breakpoint
ALTER TABLE "export" ADD COLUMN "pr_commit_sha" text;--> statement-breakpoint
ALTER TABLE "export" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "export" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_pr_commit_sha_hex" CHECK ("export"."pr_commit_sha" is null or "export"."pr_commit_sha" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_pr_complete" CHECK (("export"."pr_number" is null) = ("export"."pr_url" is null) and ("export"."pr_number" is null) = ("export"."pr_head_ref" is null) and ("export"."pr_number" is null) = ("export"."pr_commit_sha" is null));--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_pr_only_github_pr" CHECK ("export"."pr_number" is null or "export"."target_kind" = 'github_pr');--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_failure_only_failed" CHECK ("export"."failure_code" is null or ("export"."status" = 'failed' and "export"."failure_message" is not null));