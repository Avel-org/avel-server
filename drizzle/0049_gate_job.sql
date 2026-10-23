CREATE TYPE "public"."gate_job_failure" AS ENUM('precondition_failed', 'integration_moved', 'interrupted', 'timed_out', 'internal');--> statement-breakpoint
CREATE TYPE "public"."gate_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'mission.gate_queued';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'mission.gate_failed';--> statement-breakpoint
CREATE TABLE "gate_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mission_id" uuid NOT NULL,
	"status" "gate_job_status" NOT NULL,
	"operator_id" uuid NOT NULL,
	"idempotency_key" text,
	"request_sha256" text NOT NULL,
	"overrides" jsonb NOT NULL,
	"gate_run_id" uuid,
	"failure_code" "gate_job_failure",
	"failure_reason" text,
	"failure_message" text,
	"checks_total" integer,
	"checks_done" integer,
	"current_check_id" text,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gate_job_request_sha256_hex" CHECK ("gate_job"."request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "gate_job_run_iff_done" CHECK (("gate_job"."status" = 'done') = ("gate_job"."gate_run_id" is not null)),
	CONSTRAINT "gate_job_failure_iff_failed" CHECK (("gate_job"."status" = 'failed') = ("gate_job"."failure_code" is not null)),
	CONSTRAINT "gate_job_reason_only_for_precondition" CHECK ("gate_job"."failure_reason" is null or "gate_job"."failure_code" = 'precondition_failed'),
	CONSTRAINT "gate_job_started_unless_queued" CHECK (("gate_job"."status" = 'queued') = ("gate_job"."started_at" is null)),
	CONSTRAINT "gate_job_finished_iff_ended" CHECK (("gate_job"."status" in ('done', 'failed')) = ("gate_job"."finished_at" is not null)),
	CONSTRAINT "gate_job_progress_counts" CHECK (("gate_job"."checks_total" is null) = ("gate_job"."checks_done" is null) and ("gate_job"."checks_done" is null or ("gate_job"."checks_done" >= 0 and "gate_job"."checks_done" <= "gate_job"."checks_total")))
);
--> statement-breakpoint
ALTER TABLE "gate_job" ADD CONSTRAINT "gate_job_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_job" ADD CONSTRAINT "gate_job_operator_id_user_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_job" ADD CONSTRAINT "gate_job_gate_run_id_activity_log_id_fk" FOREIGN KEY ("gate_run_id") REFERENCES "public"."activity_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gate_job_one_active_per_mission_uq" ON "gate_job" USING btree ("mission_id") WHERE "gate_job"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "gate_job_idempotency_key_uq" ON "gate_job" USING btree ("mission_id","idempotency_key") WHERE "gate_job"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "gate_job_queue_idx" ON "gate_job" USING btree ("status","queued_at","id");--> statement-breakpoint
-- 0028's default privileges granted avel_app every write; a job is never deleted.
REVOKE DELETE ON gate_job FROM avel_app;
