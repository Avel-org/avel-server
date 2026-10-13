-- New enum values. Nothing in this migration uses them: ALTER TYPE ... ADD VALUE
-- runs inside the batch's transaction, and the value is unusable until it commits.
ALTER TYPE "public"."activity_action" ADD VALUE 'agent_template.updated';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'agent_template.identity_regenerated';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'agent_template';--> statement-breakpoint
CREATE TABLE "agent_identity_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_template_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"identity_md" text NOT NULL,
	"depth_md" text NOT NULL,
	"sha256" text NOT NULL,
	"identity_tokens" integer NOT NULL,
	"depth_tokens" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"generated_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_identity_version_number_positive" CHECK ("agent_identity_version"."number" > 0),
	CONSTRAINT "agent_identity_version_sha256_hex" CHECK ("agent_identity_version"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_identity_version_identity_tokens_range" CHECK ("agent_identity_version"."identity_tokens" between 0 and 800),
	CONSTRAINT "agent_identity_version_depth_tokens_range" CHECK ("agent_identity_version"."depth_tokens" between 0 and 800)
);
--> statement-breakpoint
ALTER TABLE "agent_identity_version" ADD CONSTRAINT "agent_identity_version_agent_template_id_agent_template_id_fk" FOREIGN KEY ("agent_template_id") REFERENCES "public"."agent_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identity_version" ADD CONSTRAINT "agent_identity_version_generated_by_user_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_version_template_number_uq" ON "agent_identity_version" USING btree ("agent_template_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_version_template_sha256_uq" ON "agent_identity_version" USING btree ("agent_template_id","sha256");--> statement-breakpoint
CREATE INDEX "agent_identity_version_sha256_idx" ON "agent_identity_version" USING btree ("sha256");--> statement-breakpoint
ALTER TABLE "agent_template" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agent_template" ADD CONSTRAINT "agent_template_title_length" CHECK ("agent_template"."title" is null or char_length(btrim("agent_template"."title")) between 1 and 60);--> statement-breakpoint
ALTER TABLE "agent_template" DROP COLUMN "identity_md";--> statement-breakpoint
ALTER TABLE "agent_template" DROP COLUMN "depth_md";--> statement-breakpoint
-- AgentIdentityVersion is append-only, like activity_log (0007): a version
-- number always names the same text. UPDATE and DELETE are refused row by row;
-- TRUNCATE, which skips row triggers, is refused by its own statement trigger.
CREATE FUNCTION agent_identity_version_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'agent_identity_version is append-only: % refused', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_identity_version_no_update_delete
	BEFORE UPDATE OR DELETE ON agent_identity_version
	FOR EACH ROW EXECUTE FUNCTION agent_identity_version_append_only();
--> statement-breakpoint
CREATE TRIGGER agent_identity_version_no_truncate
	BEFORE TRUNCATE ON agent_identity_version
	FOR EACH STATEMENT EXECUTE FUNCTION agent_identity_version_append_only();
