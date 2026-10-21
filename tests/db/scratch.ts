import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Runs `fn` on a database of its own, migrated to the head, then drops it.
 *
 * For statements that lock a whole table. TRUNCATE takes an exclusive lock
 * before any trigger can refuse it, so it waits for every open transaction
 * that touched the table, in every test file and every suite sharing the
 * database, and every insert queued behind it waits too. On a shared test
 * database that made the TRUNCATE tests time out and deadlock (2026-10-21).
 */
export async function onScratchDatabase(
	tag: string,
	fn: (conn: postgres.Sql) => Promise<void>,
) {
	const base = process.env.DATABASE_URL as string;
	const scratch = `avel_${tag}_${process.pid}`;
	const admin = postgres(base, { max: 1, onnotice: () => {} });
	const u = new URL(base);
	u.pathname = `/${scratch}`;
	await admin.unsafe(`drop database if exists ${scratch} with (force)`);
	await admin.unsafe(`create database ${scratch}`);
	const conn = postgres(u.toString(), { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
		await fn(conn);
	} finally {
		await conn.end();
		await admin.unsafe(`drop database if exists ${scratch} with (force)`);
		await admin.end();
	}
}

/** The error a statement raised, or null when it ran. */
export function errorOf(statement: Promise<unknown>): Promise<Error | null> {
	return statement.then(
		() => null,
		(e: Error) => e,
	);
}
