CREATE TYPE "public"."file_scope" AS ENUM('general', 'client', 'engagement');--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "file_scope" NOT NULL,
	"client_id" uuid,
	"engagement_id" uuid,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text,
	"uploaded_by" uuid NOT NULL,
	"purged_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_scope_client" CHECK (("file"."scope" = 'general') = ("file"."client_id" is null)),
	CONSTRAINT "file_scope_engagement" CHECK (("file"."scope" = 'engagement') = ("file"."engagement_id" is not null)),
	CONSTRAINT "file_name_present" CHECK (btrim("file"."name") <> ''),
	CONSTRAINT "file_bytes_nonnegative" CHECK ("file"."bytes" >= 0),
	CONSTRAINT "file_sha256_hex" CHECK ("file"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "file_purged_iff_no_storage_key" CHECK (("file"."purged_at" is null) = ("file"."storage_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "intake_files" (
	"intake_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "intake_files_intake_id_file_id_pk" PRIMARY KEY("intake_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Moved above the foreign key that references it; drizzle-kit emits indexes last.
CREATE UNIQUE INDEX "engagement_id_client_id_uq" ON "engagement" USING btree ("id","client_id");--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_engagement_client_fk" FOREIGN KEY ("engagement_id","client_id") REFERENCES "public"."engagement"("id","client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_files" ADD CONSTRAINT "intake_files_intake_id_intake_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intake"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_files" ADD CONSTRAINT "intake_files_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_client_id_idx" ON "file" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "file_engagement_id_idx" ON "file" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "intake_files_file_id_idx" ON "intake_files" USING btree ("file_id");--> statement-breakpoint
-- avel_app: the role the application connects as for tables under row-level
-- security. Not a superuser, not BYPASSRLS, and owns nothing, so every policy
-- applies to it. Roles are cluster-wide, so a second database migrated in the
-- same cluster finds it already there. Created without LOGIN: where it may log
-- in, and with which password, is the environment's to set, never git's
-- (scripts/db-init/02-create-app-role.sql locally, tests/db/global-setup.ts
-- for a local test database).
DO $$
BEGIN
	CREATE ROLE avel_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
EXCEPTION WHEN duplicate_object THEN
	NULL;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO avel_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avel_app;
--> statement-breakpoint
-- Tables later migrations create get the same grants. This covers objects the
-- migrating role creates, which is every migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO avel_app;
--> statement-breakpoint
-- activity_log is append-only by trigger; the role cannot even ask.
REVOKE UPDATE, DELETE ON activity_log FROM avel_app;
--> statement-breakpoint
-- A file row is a tombstone once purged, never removed.
REVOKE DELETE ON file FROM avel_app;
--> statement-breakpoint
-- The client a transaction is scoped to, or null. withClientScope sets
-- avel.client_id with set_config(..., true). Once a transaction that set it
-- ends, the same connection reads it back as '' rather than null, so the
-- nullif is what keeps the cast from failing on a pooled connection.
CREATE FUNCTION avel_client_scope() RETURNS uuid
LANGUAGE sql STABLE AS $$
	SELECT nullif(current_setting('avel.client_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE file ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE file FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Reads: the scoped client's rows and the general rows (client_id null).
-- Writes: exactly the scope. A client's transaction cannot write a general
-- row, which every client would then read, and an unscoped one cannot write a
-- client's row.
CREATE POLICY file_client_isolation ON file
	USING (client_id IS NULL OR client_id = (SELECT avel_client_scope()))
	WITH CHECK (client_id IS NOT DISTINCT FROM (SELECT avel_client_scope()));
--> statement-breakpoint
ALTER TABLE intake_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE intake_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A link belongs to its intake's client, through the intake's engagement.
-- Writes also need the file to be visible, and file's own policy decides
-- that: the scoped client's file or a general one, never another client's.
CREATE POLICY intake_files_client_isolation ON intake_files
	USING (EXISTS (
		SELECT 1 FROM intake i JOIN engagement e ON e.id = i.engagement_id
		WHERE i.id = intake_files.intake_id AND e.client_id = (SELECT avel_client_scope())
	))
	WITH CHECK (
		EXISTS (
			SELECT 1 FROM intake i JOIN engagement e ON e.id = i.engagement_id
			WHERE i.id = intake_files.intake_id AND e.client_id = (SELECT avel_client_scope())
		)
		AND EXISTS (SELECT 1 FROM file f WHERE f.id = intake_files.file_id)
	);
