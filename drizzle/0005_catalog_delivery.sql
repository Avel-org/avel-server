CREATE TYPE "public"."mission_skill_source" AS ENUM('template', 'pack', 'client', 'manual');--> statement-breakpoint
CREATE TYPE "public"."skill_layer" AS ENUM('role', 'stack', 'domain');--> statement-breakpoint
CREATE TYPE "public"."skill_status" AS ENUM('draft', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."skill_type" AS ENUM('knowledge', 'capability');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('pending', 'rendering', 'verifying', 'previewing', 'previewed', 'delivering', 'pr-open', 'done', 'closed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."intake_status" AS ENUM('draft', 'proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('next_module', 'calibration', 'post_delivery', 'intake_questions');--> statement-breakpoint
CREATE TYPE "public"."proposal_source" AS ENUM('code', 'model');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'dismissed', 'expired');--> statement-breakpoint
CREATE TABLE "mission_skills" (
	"mission_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"source" "mission_skill_source" NOT NULL,
	CONSTRAINT "mission_skills_mission_id_skill_id_pk" PRIMARY KEY("mission_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "role_skills" (
	"role" "role" NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "role_skills_role_skill_id_pk" PRIMARY KEY("role","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content_md" text NOT NULL,
	"avel_enhancement_md" text,
	"layer" "skill_layer" NOT NULL,
	"type" "skill_type" NOT NULL,
	"grants" text[],
	"io_shape" jsonb,
	"recommended_for" "role"[] NOT NULL,
	"source_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"status" "skill_status" NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_capability_fields" CHECK (("skill"."type" = 'capability' and "skill"."grants" is not null and "skill"."io_shape" is not null)
				or ("skill"."type" = 'knowledge' and "skill"."grants" is null and "skill"."io_shape" is null))
);
--> statement-breakpoint
CREATE TABLE "export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mission_id" uuid NOT NULL,
	"sprint_n" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"target_kind" "export_target_kind" NOT NULL,
	"connection_id" uuid,
	"status" "export_status" NOT NULL,
	"pr_status" text,
	"verification" jsonb,
	"gate_override_gate" "gate",
	"gate_override_justification" text,
	"gate_override_by" uuid,
	"gate_override_at" timestamp with time zone,
	"replay_of" uuid,
	"dry_run" boolean DEFAULT false NOT NULL,
	"preview_export_id" uuid,
	"base_commit_sha" text,
	"base_ref" text,
	"blast_radius" jsonb,
	"snapshot_key" text,
	"snapshot_sha256" text,
	"snapshot_bytes" bigint,
	"version_manifest" jsonb,
	"contract_sha256" text,
	"package_sha256" text,
	"package_hash_version" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "export_connection_unless_zip" CHECK ("export"."target_kind" = 'zip' or "export"."connection_id" is not null),
	CONSTRAINT "export_gate_override_complete" CHECK (("export"."gate_override_gate" is null and "export"."gate_override_justification" is null and "export"."gate_override_by" is null and "export"."gate_override_at" is null)
				or ("export"."gate_override_gate" is not null and btrim("export"."gate_override_justification") <> '' and "export"."gate_override_by" is not null and "export"."gate_override_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "intake" (
	"id" uuid PRIMARY KEY NOT NULL,
	"engagement_id" uuid NOT NULL,
	"status" "intake_status" NOT NULL,
	"source_md" text NOT NULL,
	"proposed_brief" jsonb,
	"open_questions" text[] NOT NULL,
	"derived_cut" "cut",
	"derived_cut_evidence" text,
	"derived_conventions" jsonb,
	"derived_boundaries" jsonb,
	"suggested_preset_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"mission_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "intake_approval_complete" CHECK ("intake"."status" <> 'approved' or ("intake"."approved_by" is not null and "intake"."approved_at" is not null and "intake"."mission_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"source" "proposal_source" NOT NULL,
	"engagement_id" uuid,
	"mission_id" uuid,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"premise" jsonb NOT NULL,
	"status" "proposal_status" NOT NULL,
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_skills" ADD CONSTRAINT "mission_skills_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_skills" ADD CONSTRAINT "mission_skills_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_skills" ADD CONSTRAINT "role_skills_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_source_id_skill_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."skill_source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_gate_override_by_user_id_fk" FOREIGN KEY ("gate_override_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_replay_of_export_id_fk" FOREIGN KEY ("replay_of") REFERENCES "public"."export"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export" ADD CONSTRAINT "export_preview_export_id_export_id_fk" FOREIGN KEY ("preview_export_id") REFERENCES "public"."export"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_suggested_preset_id_roster_preset_id_fk" FOREIGN KEY ("suggested_preset_id") REFERENCES "public"."roster_preset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_skills_skill_id_idx" ON "mission_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "role_skills_skill_id_idx" ON "role_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_slug_live_uq" ON "skill" USING btree ("slug") WHERE "skill"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "skill_source_id_idx" ON "skill" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "export_idempotency_key_uq" ON "export" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "export_mission_id_idx" ON "export" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "intake_engagement_id_idx" ON "intake" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "proposal_engagement_id_idx" ON "proposal" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "proposal_mission_id_idx" ON "proposal" USING btree ("mission_id");