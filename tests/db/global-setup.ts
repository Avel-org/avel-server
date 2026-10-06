import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Any fixed key works; it only has to be the same for every run.
const MIGRATION_LOCK = 7_265_617;

/**
 * Migrates DATABASE_URL once, before any test file runs.
 *
 * CI starts from an empty database and runs no `db:migrate`, and vitest runs
 * test files in parallel. Migrating from inside a test file raced every other
 * file that needed the tables. Here nothing else has started yet.
 *
 * The advisory lock covers two suites started at once against one database:
 * the second waits, then finds nothing pending. One connection, so the lock
 * and the migration share a session, and closing it releases the lock.
 */
export default async function setup() {
	const url = process.env.DATABASE_URL;
	if (!url) return;
	const conn = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await conn`select pg_advisory_lock(${MIGRATION_LOCK})`;
		await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
	} finally {
		await conn.end();
	}
}
