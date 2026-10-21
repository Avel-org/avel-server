CREATE TYPE "public"."dispatch_step_kind" AS ENUM('reasoning_summary', 'tool_call', 'tool_result', 'text', 'error');--> statement-breakpoint
CREATE TABLE "dispatch_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "dispatch_step_kind" NOT NULL,
	"label" text NOT NULL,
	"detail" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dispatch_step_seq_positive" CHECK ("dispatch_step"."seq" >= 1),
	CONSTRAINT "dispatch_step_label_length" CHECK (char_length(btrim("dispatch_step"."label")) between 1 and 80),
	CONSTRAINT "dispatch_step_detail_object" CHECK (jsonb_typeof("dispatch_step"."detail") = 'object'),
	CONSTRAINT "dispatch_step_ended_after_started" CHECK ("dispatch_step"."ended_at" is null or "dispatch_step"."ended_at" >= "dispatch_step"."started_at"),
	CONSTRAINT "dispatch_step_tokens_nonnegative" CHECK (("dispatch_step"."tokens_in" is null or "dispatch_step"."tokens_in" >= 0) and ("dispatch_step"."tokens_out" is null or "dispatch_step"."tokens_out" >= 0))
);
--> statement-breakpoint
ALTER TABLE "dispatch_step" ADD CONSTRAINT "dispatch_step_dispatch_id_dispatch_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_step_dispatch_seq_uq" ON "dispatch_step" USING btree ("dispatch_id","seq");--> statement-breakpoint
-- Append-only, as canon_step is: a tool call and its result are two rows,
-- never one updated.
CREATE TRIGGER dispatch_step_no_update_delete
	BEFORE UPDATE OR DELETE ON dispatch_step
	FOR EACH ROW EXECUTE FUNCTION avel_append_only();
--> statement-breakpoint
CREATE TRIGGER dispatch_step_no_truncate
	BEFORE TRUNCATE ON dispatch_step
	FOR EACH STATEMENT EXECUTE FUNCTION avel_append_only();
--> statement-breakpoint
-- 0028's default privileges granted avel_app every write; a step is never changed.
REVOKE UPDATE, DELETE ON dispatch_step FROM avel_app;
