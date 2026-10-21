-- Canon chat (J, 2026-10-20): open sessions with no client, modes, titles,
-- archive, and steps written as a turn runs. Hand-ordered from
-- drizzle-kit's output: every new NOT NULL column is filled before it is
-- required, and the (id, scope_key) target exists before anything
-- references it.
CREATE TYPE "public"."canon_mode" AS ENUM('ask', 'fetch', 'draft');--> statement-breakpoint
CREATE TYPE "public"."canon_scope" AS ENUM('open', 'client');--> statement-breakpoint
CREATE TYPE "public"."canon_step_kind" AS ENUM('reasoning_summary', 'tool_call', 'tool_result', 'text', 'error');--> statement-breakpoint
CREATE TYPE "public"."canon_title_source" AS ENUM('canon', 'operator');--> statement-breakpoint
-- canon_session. Every session so far briefed one intake: client scope, draft mode.
ALTER TABLE "canon_session" ALTER COLUMN "intake_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ALTER COLUMN "engagement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "scope" "canon_scope";--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "mode" "canon_mode";--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
UPDATE "canon_session" s SET
	"scope" = 'client',
	"mode" = 'draft',
	"last_activity_at" = coalesce(
		(SELECT max(m."created_at") FROM "canon_message" m WHERE m."canon_session_id" = s."id"),
		s."opened_at"
	);--> statement-breakpoint
ALTER TABLE "canon_session" ALTER COLUMN "scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ALTER COLUMN "mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ALTER COLUMN "last_activity_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "scope_key" uuid GENERATED ALWAYS AS (coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "title_set_by" "canon_title_source";--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "canon_session_id_scope_key_uq" ON "canon_session" USING btree ("id","scope_key");--> statement-breakpoint
CREATE INDEX "canon_session_last_activity_idx" ON "canon_session" USING btree ("last_activity_at","id");--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_scope_shape" CHECK (case "canon_session"."scope" when 'open' then "canon_session"."client_id" is null and "canon_session"."engagement_id" is null and "canon_session"."intake_id" is null else "canon_session"."client_id" is not null end);--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_intake_needs_engagement" CHECK ("canon_session"."intake_id" is null or "canon_session"."engagement_id" is not null);--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_draft_needs_intake" CHECK ("canon_session"."mode" <> 'draft' or "canon_session"."intake_id" is not null);--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_title_set_together" CHECK (("canon_session"."title" is null) = ("canon_session"."title_set_by" is null));--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_title_length" CHECK ("canon_session"."title" is null or char_length(btrim("canon_session"."title")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_archived_not_open" CHECK ("canon_session"."archived_at" is null or "canon_session"."status" <> 'open');--> statement-breakpoint
-- canon_message. Append-only, so no UPDATE: the new NOT NULL columns take
-- a default for the rows already there, then lose it. A default fills
-- existing rows without firing the row triggers.
ALTER TABLE "canon_message" DROP CONSTRAINT "canon_message_session_client_fk";--> statement-breakpoint
ALTER TABLE "canon_message" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_message" ADD COLUMN "scope_key" uuid GENERATED ALWAYS AS (coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_message" ADD COLUMN "mode" "canon_mode" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_message" ALTER COLUMN "mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "canon_message" ADD COLUMN "parts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "canon_message" ALTER COLUMN "parts" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_session_scope_fk" FOREIGN KEY ("canon_session_id","scope_key") REFERENCES "public"."canon_session"("id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_parts_array" CHECK (jsonb_typeof("canon_message"."parts") = 'array');--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_operator_has_no_parts" CHECK ("canon_message"."role" <> 'operator' or "canon_message"."parts" = '[]'::jsonb);--> statement-breakpoint
-- canon_step: append-only, like canon_message.
CREATE TABLE "canon_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canon_session_id" uuid NOT NULL,
	"client_id" uuid,
	"scope_key" uuid GENERATED ALWAYS AS (coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED NOT NULL,
	"turn" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" "canon_step_kind" NOT NULL,
	"label" text NOT NULL,
	"detail" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canon_step_turn_positive" CHECK ("canon_step"."turn" >= 1),
	CONSTRAINT "canon_step_seq_positive" CHECK ("canon_step"."seq" >= 1),
	CONSTRAINT "canon_step_label_length" CHECK (char_length(btrim("canon_step"."label")) between 1 and 80),
	CONSTRAINT "canon_step_detail_object" CHECK (jsonb_typeof("canon_step"."detail") = 'object'),
	CONSTRAINT "canon_step_ended_after_started" CHECK ("canon_step"."ended_at" is null or "canon_step"."ended_at" >= "canon_step"."started_at"),
	CONSTRAINT "canon_step_tokens_nonnegative" CHECK (("canon_step"."tokens_in" is null or "canon_step"."tokens_in" >= 0) and ("canon_step"."tokens_out" is null or "canon_step"."tokens_out" >= 0))
);
--> statement-breakpoint
ALTER TABLE "canon_step" ADD CONSTRAINT "canon_step_canon_session_id_canon_session_id_fk" FOREIGN KEY ("canon_session_id") REFERENCES "public"."canon_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canon_step" ADD CONSTRAINT "canon_step_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canon_step" ADD CONSTRAINT "canon_step_session_scope_fk" FOREIGN KEY ("canon_session_id","scope_key") REFERENCES "public"."canon_session"("id","scope_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canon_step_session_seq_uq" ON "canon_step" USING btree ("canon_session_id","seq");--> statement-breakpoint
CREATE INDEX "canon_step_client_id_idx" ON "canon_step" USING btree ("client_id");--> statement-breakpoint
CREATE TRIGGER canon_step_no_update_delete
	BEFORE UPDATE OR DELETE ON canon_step
	FOR EACH ROW EXECUTE FUNCTION avel_append_only();
--> statement-breakpoint
CREATE TRIGGER canon_step_no_truncate
	BEFORE TRUNCATE ON canon_step
	FOR EACH STATEMENT EXECUTE FUNCTION avel_append_only();
--> statement-breakpoint
-- 0028's default privileges granted avel_app every write; a step is never changed.
REVOKE UPDATE, DELETE ON canon_step FROM avel_app;--> statement-breakpoint
-- Row-level security. An open session's rows (client_id null) are visible
-- only to an unscoped transaction, a client's only in that client's scope,
-- and a write must name exactly the transaction's scope. Not the Drive's
-- general-row form (client_id IS NULL OR ...): that would show every open
-- session, which may hold several clients' operational data, inside every
-- client's scope.
ALTER TABLE canon_step ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE canon_step FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY canon_session_client_isolation ON canon_session;--> statement-breakpoint
CREATE POLICY canon_session_client_isolation ON canon_session
	USING (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()))
	WITH CHECK (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()));--> statement-breakpoint
DROP POLICY canon_message_client_isolation ON canon_message;--> statement-breakpoint
CREATE POLICY canon_message_client_isolation ON canon_message
	USING (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()))
	WITH CHECK (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()));--> statement-breakpoint
CREATE POLICY canon_step_client_isolation ON canon_step
	USING (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()))
	WITH CHECK (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()));--> statement-breakpoint
-- The fourth SECURITY DEFINER function (J, 2026-10-20). The session list
-- crosses clients, which no scope can read. It discloses each session's
-- summary and nothing else: no message, step, question or memory, and no
-- token or spend count. Executable by avel_app only.
CREATE FUNCTION canon_session_index() RETURNS TABLE (
	id uuid,
	scope public.canon_scope,
	client_id uuid,
	engagement_id uuid,
	intake_id uuid,
	title text,
	mode public.canon_mode,
	status public.canon_session_status,
	halt_reason public.canon_halt_reason,
	archived_at timestamp with time zone,
	last_activity_at timestamp with time zone,
	opened_at timestamp with time zone,
	turn_started_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT s.id, s.scope, s.client_id, s.engagement_id, s.intake_id, s.title,
		s.mode, s.status, s.halt_reason, s.archived_at, s.last_activity_at,
		s.opened_at, s.turn_started_at
	FROM public.canon_session s
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canon_session_index() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canon_session_index() TO avel_app;
