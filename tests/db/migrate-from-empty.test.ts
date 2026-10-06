import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

// Applies every migration to a database that has never seen one, which is the
// only way to prove the foreign-key order: an out-of-order table fails here.
// A throwaway database per run, so the shared test database is never reset.
const url = process.env.DATABASE_URL;
const scratch = `avel_from_empty_${process.pid}`;

// CREATE DATABASE, eleven migrations and DROP DATABASE take about 1.3s alone and
// past 10s while another suite loads the same server. The 5s and 10s defaults
// are sized for unit tests.
const BUDGET_MS = 60_000;

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

const EXPECTED_TABLES = [
	"account",
	"activity_log",
	"agent_template",
	"client",
	"completion_report",
	"connection",
	"engagement",
	"export",
	"finding",
	"intake",
	"knowledge_entry",
	"mission",
	"mission_skills",
	"playbook",
	"proposal",
	"repo_policy",
	"role_skills",
	"roster_entry",
	"roster_preset",
	"session",
	"skill",
	"skill_source",
	"user",
	"verification",
];

describe.skipIf(!url)("migrations from an empty database", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;

	afterAll(async () => {
		await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
		await admin?.end();
	}, BUDGET_MS);

	it(
		"apply in foreign-key order and create every table",
		async () => {
			if (!url || !admin) return;
			await admin.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin.unsafe(`create database ${scratch}`);

			const conn = postgres(withDatabase(url, scratch), {
				max: 1,
				onnotice: () => {},
			});
			try {
				await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
				const tables = await conn<{ tablename: string }[]>`
				select tablename from pg_tables where schemaname = 'public' order by tablename`;
				expect(tables.map((t) => t.tablename)).toEqual(EXPECTED_TABLES);
				const ext =
					await conn`select 1 from pg_extension where extname = 'vector'`;
				expect(ext).toHaveLength(1);
			} finally {
				await conn.end();
			}
		},
		BUDGET_MS,
	);
});
