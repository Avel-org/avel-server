-- 0028 is applied on avel_dev, so this pins its function rather than editing it.
-- A function the policies call resolves names through search_path; pinned, a
-- caller cannot put an object ahead of pg_catalog and change what it returns.
ALTER FUNCTION avel_client_scope() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
-- An engagement's file attaches only to that engagement's intakes. A client's
-- or a general file attaches to any intake (row-level security already keeps
-- it within one client). A trigger, not a policy, so it holds for the owner
-- too. It reads file as the caller: under avel_app a file the scope cannot
-- see finds no row here, and the intake_files policy refuses it instead.
CREATE FUNCTION intake_files_engagement_match() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public.file f
		JOIN public.intake i ON i.id = NEW.intake_id
		WHERE f.id = NEW.file_id
			AND f.engagement_id IS NOT NULL
			AND f.engagement_id <> i.engagement_id
	) THEN
		RAISE EXCEPTION 'intake_files: file % belongs to another engagement than intake %', NEW.file_id, NEW.intake_id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER intake_files_engagement_match
	BEFORE INSERT OR UPDATE ON intake_files
	FOR EACH ROW EXECUTE FUNCTION intake_files_engagement_match();
