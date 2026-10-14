ALTER TABLE "dispatch" ADD COLUMN "brief_md" text;--> statement-breakpoint
ALTER TABLE "dispatch" ADD COLUMN "brief_sha256" text;--> statement-breakpoint
ALTER TABLE "dispatch" ADD COLUMN "harness_version" text;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_brief_sha256_hex" CHECK ("dispatch"."brief_sha256" is null or "dispatch"."brief_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_brief_md_iff_sha256" CHECK (("dispatch"."brief_md" is null) = ("dispatch"."brief_sha256" is null));