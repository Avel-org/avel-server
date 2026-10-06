-- Every write that changes export.status must move status_changed_at forward
-- in the same statement. Enforced here rather than by convention. "Forward"
-- is strict: an unchanged or earlier time (a clock running backwards) is
-- refused. An update that leaves status alone is not constrained.
CREATE FUNCTION export_status_change_moves_time() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status
		AND NEW.status_changed_at <= OLD.status_changed_at THEN
		RAISE EXCEPTION 'export % changed status from % to % without moving status_changed_at forward (was %, got %)',
			OLD.id, OLD.status, NEW.status, OLD.status_changed_at, NEW.status_changed_at
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER export_status_change_moves_time
	BEFORE UPDATE OF status ON "export"
	FOR EACH ROW EXECUTE FUNCTION export_status_change_moves_time();
