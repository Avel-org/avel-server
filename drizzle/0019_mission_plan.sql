ALTER TYPE "public"."activity_action" ADD VALUE 'mission.plan_updated';--> statement-breakpoint
ALTER TABLE "mission" ADD COLUMN "template_ref" text;--> statement-breakpoint
ALTER TABLE "mission" ADD COLUMN "template_version" text;--> statement-breakpoint
ALTER TABLE "mission" ADD CONSTRAINT "mission_template_complete" CHECK (("mission"."template_ref" is null and "mission"."template_version" is null) or ("mission"."template_ref" is not null and "mission"."template_version" ~ '^[0-9a-f]{40}$'));