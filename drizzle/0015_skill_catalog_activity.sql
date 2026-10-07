ALTER TYPE "public"."activity_action" ADD VALUE 'skill_source.created';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'skill_source.updated';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'skill_source.deleted';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'skill.created';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'skill.updated';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'skill.approved';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'skill.retired';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'skill_source';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'skill';