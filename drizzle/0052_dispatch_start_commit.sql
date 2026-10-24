ALTER TABLE "dispatch" ADD COLUMN "start_commit_sha" text;--> statement-breakpoint
ALTER TABLE "dispatch" ADD COLUMN "start_dispatch_ids" uuid[];--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_start_commit_sha_hex" CHECK ("dispatch"."start_commit_sha" is null or "dispatch"."start_commit_sha" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_start_commit_iff_dispatch_ids" CHECK (("dispatch"."start_commit_sha" is null) = ("dispatch"."start_dispatch_ids" is null));--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_start_commit_only_once_started" CHECK ("dispatch"."start_commit_sha" is null or "dispatch"."status" <> 'queued');