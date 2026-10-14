CREATE TYPE "public"."dispatch_status" AS ENUM('queued', 'running', 'complete', 'blocked', 'failed', 'halted');--> statement-breakpoint
CREATE TYPE "public"."report_filed_by" AS ENUM('agent', 'system');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'finding.opened';--> statement-breakpoint
ALTER TYPE "public"."activity_entity_type" ADD VALUE 'finding';--> statement-breakpoint
CREATE TABLE "dispatch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"roster_entry_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"brief_ref" jsonb,
	"status" "dispatch_status" NOT NULL,
	"halt_reason" "halt_reason",
	"estimated_tokens" integer NOT NULL,
	"token_soft_ceiling" integer NOT NULL,
	"token_hard_ceiling" integer NOT NULL,
	"tokens_used" integer NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"soft_ceiling_crossed" boolean NOT NULL,
	"spend_usd" numeric(14, 6) NOT NULL,
	"wall_clock_minutes" integer NOT NULL,
	"agent_identity_version_id" uuid,
	"agent_version_sha256" text,
	"skills_sha256" text,
	"model" text,
	"price_version" text,
	"token_sha256" text,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dispatch_halt_reason_iff_halted" CHECK (("dispatch"."status" = 'halted') = ("dispatch"."halt_reason" is not null)),
	CONSTRAINT "dispatch_estimate_positive" CHECK ("dispatch"."estimated_tokens" > 0),
	CONSTRAINT "dispatch_soft_ceiling_at_least_estimate" CHECK ("dispatch"."token_soft_ceiling" >= "dispatch"."estimated_tokens"),
	CONSTRAINT "dispatch_hard_ceiling_at_least_soft" CHECK ("dispatch"."token_hard_ceiling" >= "dispatch"."token_soft_ceiling"),
	CONSTRAINT "dispatch_token_split_nonnegative" CHECK ("dispatch"."tokens_in" >= 0 and "dispatch"."tokens_out" >= 0 and "dispatch"."cache_read_tokens" >= 0 and "dispatch"."cache_write_tokens" >= 0),
	CONSTRAINT "dispatch_tokens_used_is_split_sum" CHECK ("dispatch"."tokens_used" = "dispatch"."tokens_in" + "dispatch"."tokens_out" + "dispatch"."cache_read_tokens" + "dispatch"."cache_write_tokens"),
	CONSTRAINT "dispatch_spend_nonnegative" CHECK ("dispatch"."spend_usd" >= 0),
	CONSTRAINT "dispatch_wall_clock_positive" CHECK ("dispatch"."wall_clock_minutes" > 0),
	CONSTRAINT "dispatch_started_iff_not_queued" CHECK (("dispatch"."status" <> 'queued') = ("dispatch"."started_at" is not null)),
	CONSTRAINT "dispatch_closed_iff_ended" CHECK (("dispatch"."status" in ('complete', 'blocked', 'failed', 'halted')) = ("dispatch"."closed_at" is not null)),
	CONSTRAINT "dispatch_closed_after_started" CHECK ("dispatch"."closed_at" is null or "dispatch"."closed_at" >= "dispatch"."started_at"),
	CONSTRAINT "dispatch_frozen_once_started" CHECK ("dispatch"."status" = 'queued' or ("dispatch"."agent_identity_version_id" is not null and "dispatch"."agent_version_sha256" is not null and "dispatch"."skills_sha256" is not null and "dispatch"."model" is not null and "dispatch"."price_version" is not null)),
	CONSTRAINT "dispatch_agent_version_sha256_hex" CHECK ("dispatch"."agent_version_sha256" is null or "dispatch"."agent_version_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dispatch_skills_sha256_hex" CHECK ("dispatch"."skills_sha256" is null or "dispatch"."skills_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dispatch_token_sha256_hex" CHECK ("dispatch"."token_sha256" is null or "dispatch"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dispatch_request_sha256_hex" CHECK ("dispatch"."request_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- Moved up by hand: dispatch_roster_entry_mission_fk below references
-- roster_entry(id, mission_id), which needs this unique index to exist first.
CREATE UNIQUE INDEX "roster_entry_id_mission_id_uq" ON "roster_entry" USING btree ("id","mission_id");--> statement-breakpoint
-- completion_report has 0 rows in every database (no write path before module
-- 6, and the seed writes none), so these NOT NULL columns need no backfill.
ALTER TABLE "completion_report" ADD COLUMN "dispatch_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "completion_report" ADD COLUMN "edge_mismatches" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "completion_report" ADD COLUMN "filed_by" "report_filed_by" NOT NULL;--> statement-breakpoint
ALTER TABLE "finding" ADD COLUMN "reported_by_dispatch_id" uuid;--> statement-breakpoint
ALTER TABLE "finding" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "finding" ADD COLUMN "request_sha256" text;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_roster_entry_id_roster_entry_id_fk" FOREIGN KEY ("roster_entry_id") REFERENCES "public"."roster_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_agent_identity_version_id_agent_identity_version_id_fk" FOREIGN KEY ("agent_identity_version_id") REFERENCES "public"."agent_identity_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_roster_entry_mission_fk" FOREIGN KEY ("roster_entry_id","mission_id") REFERENCES "public"."roster_entry"("id","mission_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_mission_id_idx" ON "dispatch" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "dispatch_roster_entry_id_idx" ON "dispatch" USING btree ("roster_entry_id");--> statement-breakpoint
CREATE INDEX "dispatch_mission_id_status_idx" ON "dispatch" USING btree ("mission_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_token_sha256_uq" ON "dispatch" USING btree ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_mission_id_idempotency_key_uq" ON "dispatch" USING btree ("mission_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_id_mission_id_uq" ON "dispatch" USING btree ("id","mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_id_mission_id_roster_entry_id_uq" ON "dispatch" USING btree ("id","mission_id","roster_entry_id");--> statement-breakpoint
ALTER TABLE "completion_report" ADD CONSTRAINT "completion_report_dispatch_fk" FOREIGN KEY ("dispatch_id","mission_id","roster_entry_id") REFERENCES "public"."dispatch"("id","mission_id","roster_entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_reported_by_dispatch_id_dispatch_id_fk" FOREIGN KEY ("reported_by_dispatch_id") REFERENCES "public"."dispatch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_dispatch_mission_fk" FOREIGN KEY ("reported_by_dispatch_id","mission_id") REFERENCES "public"."dispatch"("id","mission_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "completion_report_dispatch_id_uq" ON "completion_report" USING btree ("dispatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_dispatch_idempotency_key_uq" ON "finding" USING btree ("reported_by_dispatch_id","idempotency_key") WHERE "finding"."reported_by_dispatch_id" is not null and "finding"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_idempotency_key_iff_dispatch" CHECK (("finding"."idempotency_key" is not null) = ("finding"."reported_by_dispatch_id" is not null));--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_request_sha256_iff_key" CHECK (("finding"."request_sha256" is not null) = ("finding"."idempotency_key" is not null));--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_request_sha256_hex" CHECK ("finding"."request_sha256" is null or "finding"."request_sha256" ~ '^[0-9a-f]{64}$');