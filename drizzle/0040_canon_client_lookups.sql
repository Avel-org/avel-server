-- The only SECURITY DEFINER functions (BE Main, 2026-10-19). Canon's own
-- tables are under row-level security, so a route keyed by a session,
-- question or memory id cannot read the row to learn its client, and the
-- client is the scope it needs. Each function discloses that one fact, the
-- id's client_id, or null for an unknown id; nothing else. The route then
-- reads and writes the row under withClientScope, so the policies still
-- guard it. They run as the owner, which must bypass row-level security (a
-- superuser locally, neon_superuser on Neon); an owner that did not would
-- see nothing here and every id-keyed route would answer 404, failing safe.
-- Executable by avel_app only.
CREATE FUNCTION canon_session_client_id(session_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT client_id FROM public.canon_session WHERE id = session_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canon_session_client_id(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canon_session_client_id(uuid) TO avel_app;
--> statement-breakpoint
CREATE FUNCTION canon_question_client_id(question_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT client_id FROM public.canon_question WHERE id = question_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canon_question_client_id(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canon_question_client_id(uuid) TO avel_app;
--> statement-breakpoint
CREATE FUNCTION client_memory_client_id(memory_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT client_id FROM public.client_memory WHERE id = memory_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION client_memory_client_id(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION client_memory_client_id(uuid) TO avel_app;
