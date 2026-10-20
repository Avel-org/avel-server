-- canon_question.source_file_ids becomes source_chunk_ids: a file id lost the
-- passage, and the passage is the point (BE Main, 2026-10-19). Renamed in
-- place, not dropped and re-added. No rows existed anywhere when this was
-- written. If some do, their file ids cannot become chunk ids, and the CHECK
-- below fails the migration rather than keeping them.
ALTER TABLE "canon_question" RENAME COLUMN "source_file_ids" TO "source_chunk_ids";--> statement-breakpoint
ALTER TABLE "canon_question" ALTER COLUMN "source_chunk_ids" SET DATA TYPE text[] USING "source_chunk_ids"::text[];--> statement-breakpoint
ALTER TABLE "canon_question" ADD CONSTRAINT "canon_question_source_chunk_ids_format" CHECK (array_position("canon_question"."source_chunk_ids", null) is null and array_to_string("canon_question"."source_chunk_ids", ',') ~ '^([0-9a-f]{64}:[1-9][0-9]*-[1-9][0-9]*(,[0-9a-f]{64}:[1-9][0-9]*-[1-9][0-9]*)*)?$');
