-- A file row's ownership and content never change after insert: its scope,
-- client and engagement (whose rows these are, and so who may read them), and
-- sha256, bytes, mime and uploaded_by (what the bytes are, and who brought
-- them). A purge is one-way: once purged_at is set it stays, and storage_key
-- stays null. A rename, a soft delete and updated_at still go through. A
-- trigger, so the owner is held too. Decided by BE Main, 2026-10-19.
CREATE FUNCTION file_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF NEW.scope IS DISTINCT FROM OLD.scope
		OR NEW.client_id IS DISTINCT FROM OLD.client_id
		OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
		OR NEW.sha256 IS DISTINCT FROM OLD.sha256
		OR NEW.bytes IS DISTINCT FROM OLD.bytes
		OR NEW.mime IS DISTINCT FROM OLD.mime
		OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	THEN
		RAISE EXCEPTION 'file %: scope, client, engagement and content are fixed at upload', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.purged_at IS NOT NULL AND (
		NEW.purged_at IS DISTINCT FROM OLD.purged_at
		OR NEW.storage_key IS NOT NULL
	) THEN
		RAISE EXCEPTION 'file %: a purge is not undone', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER file_immutable
	BEFORE UPDATE ON file
	FOR EACH ROW EXECUTE FUNCTION file_immutable();
