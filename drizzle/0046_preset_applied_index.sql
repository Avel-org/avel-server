-- GET /api/presets/:id/applications reads activity_log by action and
-- payload->>'presetId', newest first; no index served it. Keyed on exactly
-- those two, in its (at desc, id desc) order, over the rows whose payload
-- names a preset. Not partial on the action: an enum literal is refused in a
-- batch that also adds the value (55P04), and action::text is not immutable.
-- tests/db/preset-applications-index.test.ts proves the planner uses it.
CREATE INDEX "activity_log_preset_applied_idx" ON "activity_log" USING btree ("action",("payload"->>'presetId'),"at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE ("activity_log"."payload"->>'presetId') is not null;