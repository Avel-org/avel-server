import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { clientIdOfClient } from "../../src/db/client-id";
import * as schema from "../../src/db/schema";
import { client, engagement, user } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { clock } from "./fixtures";

/**
 * The connection string for avel_app, the role the row-level security tests
 * run as. AVEL_APP_DATABASE_URL wins; otherwise DATABASE_URL with avel_app's
 * local credentials, which tests/db/global-setup.ts sets on a local _test
 * database. Never postgres: a superuser bypasses every policy.
 */
export function appRoleUrl() {
	const explicit = process.env.AVEL_APP_DATABASE_URL;
	if (explicit) return explicit;
	const url = new URL(process.env.DATABASE_URL ?? "");
	url.username = "avel_app";
	url.password = "avel_app";
	return url.toString();
}

/** A drizzle client on one avel_app connection, so two transactions share it. */
export function connectAsApp() {
	const conn = postgres(appRoleUrl(), { max: 1, onnotice: () => {} });
	return { db: drizzle(conn, { schema }), end: () => conn.end() };
}

/**
 * A user, and per name a client, an engagement and an intake. Ids are random
 * unless given, because test files run in parallel against one database.
 */
export async function seedTenants(
	tx: Tx,
	names: string[],
	clientIds: string[] = [],
) {
	const userId = randomUUID();
	await tx.insert(user).values({
		id: userId,
		name: "Operator",
		email: `${userId}@example.test`,
		emailVerified: true,
		githubId: userId,
		githubLogin: `op-${userId.slice(0, 8)}`,
		...stamp(clock),
	});
	const tenants = [];
	for (const [i, name] of names.entries()) {
		const clientId = clientIds[i] ?? randomUUID();
		const engagementId = randomUUID();
		const intakeId = randomUUID();
		await tx
			.insert(client)
			.values({ id: clientId, name, status: "active", ...stamp(clock) });
		await tx.insert(engagement).values({
			id: engagementId,
			clientId,
			name: `${name} build`,
			status: "active",
			startedAt: clock.now(),
			...stamp(clock),
		});
		// Raw, naming only these columns: a migration test seeds a database
		// migrated to an earlier step, where Drizzle's insert would name every
		// column the schema has now (consent_file_id arrived in 0059).
		const at = clock.now().toISOString();
		await tx.execute(
			sql`insert into intake (id, engagement_id, status, source_md, open_questions, created_at, updated_at)
				values (${intakeId}, ${engagementId}, 'draft', '# Brief', '{}', ${at}::timestamptz, ${at}::timestamptz)`,
		);
		const scope = await clientIdOfClient(tx, clientId);
		if (!scope) throw new Error("seedTenants: the client row is missing");
		tenants.push({ clientId, engagementId, intakeId, scope });
	}
	const [a, b] = tenants;
	if (!a) throw new Error("seedTenants needs at least one name");
	return { userId, tenants, a, b: b ?? a };
}

/** The single row a query must return; throws instead of handing back undefined. */
export function one<T>(rows: readonly T[]): T {
	const [row] = rows;
	if (row === undefined) throw new Error("expected a row, got none");
	return row;
}
