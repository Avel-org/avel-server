-- A dispatch records its wave (decided 2026-10-22: start wave refuses while
-- an earlier wave is open). Added nullable, backfilled from the roster
-- entry's earliest wave, then NOT NULL, so a table with rows migrates. An
-- entry with no waves takes A, the earliest there is: only dev data predates
-- this.
ALTER TABLE "dispatch" ADD COLUMN "wave" "wave";--> statement-breakpoint
UPDATE "dispatch" SET "wave" = coalesce((SELECT min(w) FROM "roster_entry" re, unnest(re."waves") AS w WHERE re."id" = "dispatch"."roster_entry_id"), 'A');--> statement-breakpoint
ALTER TABLE "dispatch" ALTER COLUMN "wave" SET NOT NULL;
