ALTER TABLE "activity_log" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The backfill. Every older row gets the client it touches, found the way
-- logActivity now finds it: the client entity, the engagement, the
-- mission's engagement, and for rows with neither, the client's memory, a
-- Canon session or a Canon question. Rows on no client stay null.
--
-- Two guards are lifted for it, inside this one transaction (the migrator
-- applies its batch in one), and put back before it commits:
-- - activity_log_no_update_delete refuses UPDATE. It also refuses DELETE,
--   so DELETE is unguarded for the same window. That is safe: DISABLE
--   TRIGGER takes a SHARE ROW EXCLUSIVE lock on activity_log, held until
--   this transaction ends, so no other session can insert, update or delete
--   a row while the trigger is off, and it commits with the trigger back on
--   or rolls back with it never off. Nothing here deletes.
-- - client_memory, canon_session and canon_question FORCE row-level
--   security, which applies to their owner too. On Neon the owner is not a
--   superuser, so without lifting FORCE the joins below read none of their
--   rows and those activity rows stay null. A local superuser bypasses RLS
--   either way, so tests/db/activity-client-backfill.test.ts runs this as a
--   non-superuser owner.
-- entity_type is compared as text: in a batch that also applies 0030 or
-- 0042, which add 'client_memory' and the canon values to the enum, an enum
-- literal of a value added in the same transaction is refused ("unsafe use
-- of new value").
ALTER TABLE "client_memory" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "canon_session" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "canon_question" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_log" DISABLE TRIGGER "activity_log_no_update_delete";--> statement-breakpoint
UPDATE "activity_log" "a" SET "client_id" = "c"."id"
	FROM "client" "c"
	WHERE "a"."client_id" IS NULL AND "a"."entity_type"::text = 'client' AND "c"."id" = "a"."entity_id";--> statement-breakpoint
UPDATE "activity_log" "a" SET "client_id" = "e"."client_id"
	FROM "engagement" "e"
	WHERE "a"."client_id" IS NULL AND "e"."id" = "a"."engagement_id";--> statement-breakpoint
UPDATE "activity_log" "a" SET "client_id" = "e"."client_id"
	FROM "mission" "m" JOIN "engagement" "e" ON "e"."id" = "m"."engagement_id"
	WHERE "a"."client_id" IS NULL AND "m"."id" = "a"."mission_id";--> statement-breakpoint
UPDATE "activity_log" "a" SET "client_id" = "cm"."client_id"
	FROM "client_memory" "cm"
	WHERE "a"."client_id" IS NULL AND "a"."entity_type"::text = 'client_memory' AND "cm"."id" = "a"."entity_id";--> statement-breakpoint
UPDATE "activity_log" "a" SET "client_id" = "s"."client_id"
	FROM "canon_session" "s"
	WHERE "a"."client_id" IS NULL AND "a"."entity_type"::text = 'canon_session' AND "s"."id" = "a"."entity_id" AND "s"."client_id" IS NOT NULL;--> statement-breakpoint
UPDATE "activity_log" "a" SET "client_id" = "q"."client_id"
	FROM "canon_question" "q"
	WHERE "a"."client_id" IS NULL AND "a"."entity_type"::text = 'canon_question' AND "q"."id" = "a"."entity_id";--> statement-breakpoint
ALTER TABLE "activity_log" ENABLE TRIGGER "activity_log_no_update_delete";--> statement-breakpoint
ALTER TABLE "client_memory" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "canon_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "canon_question" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "activity_log_client_id_at_idx" ON "activity_log" USING btree ("client_id","at","id");
