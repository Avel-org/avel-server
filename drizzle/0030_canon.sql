CREATE TYPE "public"."canon_halt_reason" AS ENUM('token_hard_ceiling', 'spend_ceiling', 'operator');
--> statement-breakpoint
CREATE TYPE "public"."canon_message_role" AS ENUM('operator', 'canon');
--> statement-breakpoint
CREATE TYPE "public"."canon_question_status" AS ENUM('open', 'answered', 'acknowledged', 'dismissed');
--> statement-breakpoint
CREATE TYPE "public"."canon_session_status" AS ENUM('open', 'closed', 'halted');
--> statement-breakpoint
CREATE TYPE "public"."client_memory_status" AS ENUM('proposed', 'kept', 'removed');
--> statement-breakpoint
CREATE TABLE "canon_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canon_session_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "canon_message_role" NOT NULL,
	"content_md" text NOT NULL,
	"citations" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canon_message_citations_array" CHECK (jsonb_typeof("canon_message"."citations") = 'array'),
	CONSTRAINT "canon_message_operator_cites_nothing" CHECK ("canon_message"."role" <> 'operator' or "canon_message"."citations" = '[]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "canon_question" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intake_id" uuid NOT NULL,
	"canon_session_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"header" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"multi_select" boolean NOT NULL,
	"reason" text NOT NULL,
	"source_file_ids" uuid[] NOT NULL,
	"status" "canon_question_status" NOT NULL,
	"answer" jsonb,
	"effect_md" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canon_question_header_length" CHECK (char_length(btrim("canon_question"."header")) between 1 and 12),
	CONSTRAINT "canon_question_options_two_to_four" CHECK (case when jsonb_typeof("canon_question"."options") = 'array' then jsonb_array_length("canon_question"."options") between 2 and 4 else false end),
	CONSTRAINT "canon_question_decided_iff_not_open" CHECK (("canon_question"."status" <> 'open') = ("canon_question"."decided_by" is not null) and ("canon_question"."status" <> 'open') = ("canon_question"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "canon_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intake_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "canon_session_status" NOT NULL,
	"halt_reason" "canon_halt_reason",
	"agent_identity_version_id" uuid NOT NULL,
	"model" text NOT NULL,
	"price_version" text NOT NULL,
	"harness_version" text NOT NULL,
	"estimated_tokens" integer NOT NULL,
	"token_soft_ceiling" integer NOT NULL,
	"token_hard_ceiling" integer NOT NULL,
	"tokens_used" integer NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"spend_usd" numeric(14, 6) NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canon_session_halt_reason_iff_halted" CHECK (("canon_session"."status" = 'halted') = ("canon_session"."halt_reason" is not null)),
	CONSTRAINT "canon_session_estimate_positive" CHECK ("canon_session"."estimated_tokens" > 0),
	CONSTRAINT "canon_session_soft_ceiling_at_least_estimate" CHECK ("canon_session"."token_soft_ceiling" >= "canon_session"."estimated_tokens"),
	CONSTRAINT "canon_session_hard_ceiling_at_least_soft" CHECK ("canon_session"."token_hard_ceiling" >= "canon_session"."token_soft_ceiling"),
	CONSTRAINT "canon_session_token_split_nonnegative" CHECK ("canon_session"."tokens_in" >= 0 and "canon_session"."tokens_out" >= 0 and "canon_session"."cache_read_tokens" >= 0 and "canon_session"."cache_write_tokens" >= 0),
	CONSTRAINT "canon_session_tokens_used_is_split_sum" CHECK ("canon_session"."tokens_used" = "canon_session"."tokens_in" + "canon_session"."tokens_out" + "canon_session"."cache_read_tokens" + "canon_session"."cache_write_tokens"),
	CONSTRAINT "canon_session_spend_nonnegative" CHECK ("canon_session"."spend_usd" >= 0),
	CONSTRAINT "canon_session_closed_iff_ended" CHECK (("canon_session"."status" <> 'open') = ("canon_session"."closed_at" is not null)),
	CONSTRAINT "canon_session_closed_after_opened" CHECK ("canon_session"."closed_at" is null or "canon_session"."closed_at" >= "canon_session"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "client_memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"content_md" text NOT NULL,
	"status" "client_memory_status" NOT NULL,
	"proposed_by_canon_session_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "client_memory_decided_together" CHECK (("client_memory"."decided_by" is null) = ("client_memory"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "intake" ADD COLUMN "drafted_by_canon_session_id" uuid;
--> statement-breakpoint
ALTER TABLE "intake" ADD COLUMN "recommended_roster" jsonb;
--> statement-breakpoint
-- Unique indexes first: drizzle-kit emits them last, after the composite
-- foreign keys that need them as targets.
CREATE UNIQUE INDEX "canon_message_session_seq_uq" ON "canon_message" USING btree ("canon_session_id","seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "canon_session_id_client_id_uq" ON "canon_session" USING btree ("id","client_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "canon_session_id_intake_id_uq" ON "canon_session" USING btree ("id","intake_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "canon_session_id_intake_id_client_id_uq" ON "canon_session" USING btree ("id","intake_id","client_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "intake_id_engagement_id_uq" ON "intake" USING btree ("id","engagement_id");
--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_canon_session_id_canon_session_id_fk" FOREIGN KEY ("canon_session_id") REFERENCES "public"."canon_session"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_session_client_fk" FOREIGN KEY ("canon_session_id","client_id") REFERENCES "public"."canon_session"("id","client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_question" ADD CONSTRAINT "canon_question_intake_id_intake_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intake"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_question" ADD CONSTRAINT "canon_question_canon_session_id_canon_session_id_fk" FOREIGN KEY ("canon_session_id") REFERENCES "public"."canon_session"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_question" ADD CONSTRAINT "canon_question_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_question" ADD CONSTRAINT "canon_question_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_question" ADD CONSTRAINT "canon_question_session_intake_client_fk" FOREIGN KEY ("canon_session_id","intake_id","client_id") REFERENCES "public"."canon_session"("id","intake_id","client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_intake_id_intake_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intake"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_agent_identity_version_id_agent_identity_version_id_fk" FOREIGN KEY ("agent_identity_version_id") REFERENCES "public"."agent_identity_version"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_intake_engagement_fk" FOREIGN KEY ("intake_id","engagement_id") REFERENCES "public"."intake"("id","engagement_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_engagement_client_fk" FOREIGN KEY ("engagement_id","client_id") REFERENCES "public"."engagement"("id","client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_memory" ADD CONSTRAINT "client_memory_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_memory" ADD CONSTRAINT "client_memory_proposed_by_canon_session_id_canon_session_id_fk" FOREIGN KEY ("proposed_by_canon_session_id") REFERENCES "public"."canon_session"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_memory" ADD CONSTRAINT "client_memory_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_memory" ADD CONSTRAINT "client_memory_session_client_fk" FOREIGN KEY ("proposed_by_canon_session_id","client_id") REFERENCES "public"."canon_session"("id","client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "canon_message_client_id_idx" ON "canon_message" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "canon_question_intake_id_status_idx" ON "canon_question" USING btree ("intake_id","status");
--> statement-breakpoint
CREATE INDEX "canon_question_client_id_idx" ON "canon_question" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "canon_session_intake_id_idx" ON "canon_session" USING btree ("intake_id");
--> statement-breakpoint
CREATE INDEX "canon_session_client_id_idx" ON "canon_session" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "client_memory_client_id_idx" ON "client_memory" USING btree ("client_id");
--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_drafted_by_canon_session_id_canon_session_id_fk" FOREIGN KEY ("drafted_by_canon_session_id") REFERENCES "public"."canon_session"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_drafted_by_canon_session_fk" FOREIGN KEY ("drafted_by_canon_session_id","id") REFERENCES "public"."canon_session"("id","intake_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Generic append-only guard, named for the table it refuses on. Pinned
-- search_path, as every function here is.
CREATE FUNCTION avel_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER canon_message_no_update_delete
	BEFORE UPDATE OR DELETE ON canon_message
	FOR EACH ROW EXECUTE FUNCTION avel_append_only();
--> statement-breakpoint
CREATE TRIGGER canon_message_no_truncate
	BEFORE TRUNCATE ON canon_message
	FOR EACH STATEMENT EXECUTE FUNCTION avel_append_only();
--> statement-breakpoint
-- 0028's default privileges granted avel_app SELECT, INSERT, UPDATE and DELETE
-- on these tables. None of them is hard-deleted (a session is evidence, a
-- question outlives its session, memory is removed by status), and a message
-- is never changed.
REVOKE DELETE ON canon_session, canon_message, canon_question, client_memory FROM avel_app;
--> statement-breakpoint
REVOKE UPDATE ON canon_message FROM avel_app;
--> statement-breakpoint
ALTER TABLE canon_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE canon_session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE canon_message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE canon_message FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE canon_question ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE canon_question FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE client_memory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE client_memory FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- No general rows here: client_id is NOT NULL. A read sees only the scoped
-- client's rows, none when unscoped; a write must name exactly that client.
CREATE POLICY canon_session_client_isolation ON canon_session
	USING (client_id = (SELECT avel_client_scope()))
	WITH CHECK (client_id = (SELECT avel_client_scope()));
--> statement-breakpoint
CREATE POLICY canon_message_client_isolation ON canon_message
	USING (client_id = (SELECT avel_client_scope()))
	WITH CHECK (client_id = (SELECT avel_client_scope()));
--> statement-breakpoint
CREATE POLICY canon_question_client_isolation ON canon_question
	USING (client_id = (SELECT avel_client_scope()))
	WITH CHECK (client_id = (SELECT avel_client_scope()));
--> statement-breakpoint
CREATE POLICY client_memory_client_isolation ON client_memory
	USING (client_id = (SELECT avel_client_scope()))
	WITH CHECK (client_id = (SELECT avel_client_scope()));
