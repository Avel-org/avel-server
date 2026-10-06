CREATE TYPE "public"."cut" AS ENUM('horizontal', 'vertical');--> statement-breakpoint
CREATE TYPE "public"."gate" AS ENUM('phase1-close', 'alignment', 'qa', 'security', 'rollback', 'acceptance');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('foundations', 'schema', 'contract', 'design-system', 'fixture', 'domain', 'api-surface', 'integration', 'realtime', 'auth', 'state', 'interface', 'backend-tests', 'frontend-tests', 'property-tests', 'accessibility', 'performance', 'spec-check', 'spec-judgment', 'security-review', 'compliance-review', 'adversarial', 'reconciliation', 'concurrency', 'deploy', 'recovery', 'observability', 'incident-response', 'intake', 'strategy', 'research', 'client-ops', 'knowledge', 'render', 'ship-decision');--> statement-breakpoint
CREATE TYPE "public"."wave" AS ENUM('A', 'B', 'C', 'D', 'E');--> statement-breakpoint
CREATE TYPE "public"."agent_kind" AS ENUM('horizontal', 'feature');--> statement-breakpoint
CREATE TYPE "public"."completion_status" AS ENUM('complete', 'blocked', 'failed', 'halted');--> statement-breakpoint
CREATE TYPE "public"."cut_source" AS ENUM('derived', 'overridden');--> statement-breakpoint
CREATE TYPE "public"."deliverable" AS ENUM('pr', 'report', 'recommendation');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'confirmed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."grain" AS ENUM('merged', 'default', 'split');--> statement-breakpoint
CREATE TYPE "public"."halt_reason" AS ENUM('token_hard_ceiling', 'spend_ceiling', 'wall_clock');--> statement-breakpoint
CREATE TYPE "public"."knowledge_type" AS ENUM('pattern', 'decision', 'registry', 'component', 'reference', 'anti-pattern');--> statement-breakpoint
CREATE TYPE "public"."mission_origin" AS ENUM('internal', 'client');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('draft', 'active', 'halted', 'shipped', 'archived');--> statement-breakpoint
CREATE TYPE "public"."version_source" AS ENUM('recorded', 'reconstructed');--> statement-breakpoint
CREATE TABLE "agent_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "agent_kind" NOT NULL,
	"roles" "role"[] NOT NULL,
	"engagement_id" uuid,
	"wave_defaults" "wave"[] NOT NULL,
	"identity_md" text NOT NULL,
	"depth_md" text NOT NULL,
	"writable_paths" text[] NOT NULL,
	"version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "completion_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"roster_entry_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"status" "completion_status" NOT NULL,
	"halt_reason" "halt_reason",
	"soft_ceiling_crossed" boolean NOT NULL,
	"actual_tokens" integer NOT NULL,
	"agent_version_sha256" text NOT NULL,
	"skills_sha256" text NOT NULL,
	"version_source" "version_source" NOT NULL,
	"model" text NOT NULL,
	"artifacts_read" jsonb NOT NULL,
	"artifacts_written" jsonb NOT NULL,
	"files_touched" integer NOT NULL,
	"file_types_touched" text[] NOT NULL,
	"rereads" integer NOT NULL,
	"blockers" jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "completion_report_halt_reason_iff_halted" CHECK (("completion_report"."status" = 'halted') = ("completion_report"."halt_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "finding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mission_id" uuid NOT NULL,
	"client_id" uuid,
	"rule" text NOT NULL,
	"subject" text NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"class" text NOT NULL,
	"status" "finding_status" NOT NULL,
	"dismissed_reason" text,
	"caught_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "finding_dismissed_has_reason" CHECK ("finding"."status" <> 'dismissed' or ("finding"."dismissed_reason" is not null and btrim("finding"."dismissed_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "knowledge_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "knowledge_type" NOT NULL,
	"agent_id" uuid,
	"client_id" uuid,
	"supersedes" uuid,
	"content_md" text NOT NULL,
	"version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"engagement_id" uuid NOT NULL,
	"origin" "mission_origin" NOT NULL,
	"type" text NOT NULL,
	"brief" jsonb NOT NULL,
	"sprint_n" integer NOT NULL,
	"status" "mission_status" NOT NULL,
	"cut" "cut" NOT NULL,
	"cut_source" "cut_source" NOT NULL,
	"cut_rationale" text,
	"repo_url" text NOT NULL,
	"spend_ceiling_usd" numeric(12, 2),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mission_override_has_rationale" CHECK ("mission"."cut_source" <> 'overridden' or ("mission"."cut_rationale" is not null and btrim("mission"."cut_rationale") <> ''))
);
--> statement-breakpoint
CREATE TABLE "playbook" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mission_type" text NOT NULL,
	"name" text NOT NULL,
	"waves_applicable" "wave"[] NOT NULL,
	"gates" jsonb NOT NULL,
	"deliverable" "deliverable" NOT NULL,
	"required_fields" text[] NOT NULL,
	"default_preset_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mission_id" uuid NOT NULL,
	"agent_template_id" uuid NOT NULL,
	"active" boolean NOT NULL,
	"waves" "wave"[] NOT NULL,
	"customized_md" text,
	"writable_paths" text[],
	"territory" text,
	"estimated_tokens" integer,
	"token_soft_ceiling" integer,
	"token_hard_ceiling" integer,
	"grain" "grain" NOT NULL,
	"absorbed_boundaries" text[] NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_preset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cut" "cut" NOT NULL,
	"agents" jsonb NOT NULL,
	"version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_template" ADD CONSTRAINT "agent_template_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_report" ADD CONSTRAINT "completion_report_roster_entry_id_roster_entry_id_fk" FOREIGN KEY ("roster_entry_id") REFERENCES "public"."roster_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_report" ADD CONSTRAINT "completion_report_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_agent_id_agent_template_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_supersedes_knowledge_entry_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."knowledge_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission" ADD CONSTRAINT "mission_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook" ADD CONSTRAINT "playbook_default_preset_id_roster_preset_id_fk" FOREIGN KEY ("default_preset_id") REFERENCES "public"."roster_preset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_agent_template_id_agent_template_id_fk" FOREIGN KEY ("agent_template_id") REFERENCES "public"."agent_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_template_slug_live_uq" ON "agent_template" USING btree ("slug") WHERE "agent_template"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agent_template_engagement_id_idx" ON "agent_template" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "completion_report_roster_entry_id_idx" ON "completion_report" USING btree ("roster_entry_id");--> statement-breakpoint
CREATE INDEX "completion_report_mission_id_idx" ON "completion_report" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "finding_mission_id_idx" ON "finding" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "finding_client_id_idx" ON "finding" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "knowledge_entry_agent_id_idx" ON "knowledge_entry" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "knowledge_entry_client_id_idx" ON "knowledge_entry" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mission_engagement_id_idx" ON "mission" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_mission_type_live_uq" ON "playbook" USING btree ("mission_type") WHERE "playbook"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "roster_entry_mission_id_idx" ON "roster_entry" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "roster_entry_agent_template_id_idx" ON "roster_entry" USING btree ("agent_template_id");