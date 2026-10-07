ALTER TYPE "public"."activity_action" ADD VALUE 'roster.entry_added';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'roster.entry_updated';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'roster.entry_removed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'roster.preset_applied';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'mission.skill_attached';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'mission.skill_detached';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'roster_entry';