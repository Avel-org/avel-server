ALTER TABLE "canon_message" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "canon_message" ADD COLUMN "request_sha256" text;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "turn_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "request_sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX "canon_message_session_idempotency_key_uq" ON "canon_message" USING btree ("canon_session_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canon_session_one_open_per_intake" ON "canon_session" USING btree ("intake_id") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "canon_session_intake_idempotency_key_uq" ON "canon_session" USING btree ("intake_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_idempotency_complete" CHECK (("canon_message"."idempotency_key" is null) = ("canon_message"."request_sha256" is null));--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_request_sha256_hex" CHECK ("canon_message"."request_sha256" is null or "canon_message"."request_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "canon_message" ADD CONSTRAINT "canon_message_key_only_operator" CHECK ("canon_message"."idempotency_key" is null or "canon_message"."role" = 'operator');--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_turn_only_open" CHECK ("canon_session"."turn_started_at" is null or "canon_session"."status" = 'open');--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_no_spend_ceiling" CHECK ("canon_session"."halt_reason" is null or "canon_session"."halt_reason" <> 'spend_ceiling');--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_idempotency_complete" CHECK (("canon_session"."idempotency_key" is null) = ("canon_session"."request_sha256" is null));--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_request_sha256_hex" CHECK ("canon_session"."request_sha256" is null or "canon_session"."request_sha256" ~ '^[0-9a-f]{64}$');