-- Runs once, when the volume is first created. The role the app connects as
-- for tables under row-level security (drizzle/0028_drive.sql creates it
-- NOLOGIN where it does not exist yet). Local credentials only: avel_app /
-- avel_app. On a volume created before this file, tests/db/global-setup.ts
-- sets the same login when it migrates a local _test database.
CREATE ROLE avel_app LOGIN PASSWORD 'avel_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
