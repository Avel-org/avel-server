ALTER TYPE "public"."activity_action" ADD VALUE 'finding.check_set';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'proposal.approved';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'proposal.dismissed';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'proposal';--> statement-breakpoint
ALTER TABLE "finding" ADD COLUMN "check" jsonb;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_check_only_confirmed" CHECK ("finding"."check" is null or "finding"."status" = 'confirmed');