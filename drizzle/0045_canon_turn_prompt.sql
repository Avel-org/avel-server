ALTER TABLE "canon_session" ADD COLUMN "turn_prompt_seq" integer;--> statement-breakpoint
ALTER TABLE "canon_session" ADD COLUMN "turn_prompt_sha256" text;--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_turn_prompt_complete" CHECK (("canon_session"."turn_prompt_seq" is null) = ("canon_session"."turn_prompt_sha256" is null));--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_turn_prompt_seq_positive" CHECK ("canon_session"."turn_prompt_seq" is null or "canon_session"."turn_prompt_seq" > 0);--> statement-breakpoint
ALTER TABLE "canon_session" ADD CONSTRAINT "canon_session_turn_prompt_sha256_hex" CHECK ("canon_session"."turn_prompt_sha256" is null or "canon_session"."turn_prompt_sha256" ~ '^[0-9a-f]{64}$');