import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let connection: ReturnType<typeof postgres> | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * Connects on first use, never at import.
 *
 * The previous build connected at module load, so its database tests crashed
 * instead of skipping when no database was configured. Connecting lazily is
 * what lets "skip when there is no database" actually skip.
 */
export function getDb() {
	if (database) return database;
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			"DATABASE_URL is not set. Copy .env.example to .env, or run docker compose up -d.",
		);
	}
	connection = postgres(url, { max: 5 });
	database = drizzle(connection, { schema });
	return database;
}

export async function closeDb() {
	await connection?.end();
	connection = undefined;
	database = undefined;
}
