ALTER TYPE "public"."activity_action" ADD VALUE 'mission.created';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'mission.status_changed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'export.created';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'export.status_changed';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'mission';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'export';