-- ActivityLog is append-only, enforced by the database rather than by convention.
-- UPDATE and DELETE are refused row by row; TRUNCATE, which skips row triggers,
-- is refused by its own statement trigger.
CREATE FUNCTION activity_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'activity_log is append-only: % refused', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER activity_log_no_update_delete
	BEFORE UPDATE OR DELETE ON activity_log
	FOR EACH ROW EXECUTE FUNCTION activity_log_append_only();
--> statement-breakpoint
CREATE TRIGGER activity_log_no_truncate
	BEFORE TRUNCATE ON activity_log
	FOR EACH STATEMENT EXECUTE FUNCTION activity_log_append_only();
