ALTER TYPE "public"."activity_action" ADD VALUE 'dispatch.created';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'dispatch.started';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'dispatch.soft_ceiling_crossed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'dispatch.halted';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'dispatch.closed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'completion_report.filed';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'dispatch';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'completion_report';--> statement-breakpoint
ALTER TYPE "public"."halt_reason" ADD VALUE 'operator';