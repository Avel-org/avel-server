-- Rows that already exist get their created_at, the earliest time the current
-- status could have begun. Added nullable, backfilled, then made NOT NULL, so
-- this applies to a table that already holds exports. No default: app code
-- sets it from the clock on every status write.
ALTER TABLE "export" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "export" SET "status_changed_at" = "created_at";--> statement-breakpoint
ALTER TABLE "export" ALTER COLUMN "status_changed_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_status_changed_after_created" CHECK ("export"."status_changed_at" >= "export"."created_at");
