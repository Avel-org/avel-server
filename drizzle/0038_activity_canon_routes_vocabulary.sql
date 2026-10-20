ALTER TYPE "public"."activity_action" ADD VALUE 'canon_session.opened';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'canon_session.closed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'canon_session.halted';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'canon_question.asked';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'canon_question.answered';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'canon_question.acknowledged';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'canon_question.dismissed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'client_memory.proposed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'client_memory.kept';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'client_memory.edited';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'client_memory.removed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'client_memory.written';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'intake.drafted_by_canon';