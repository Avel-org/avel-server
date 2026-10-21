import { desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { touchesClient } from "../../src/db/activity";
import { activityLog } from "../../src/db/schema";

// A client's activity list and its lastActivityAt read activity_log by
// client_id. With 200,000 rows over 200 clients and one sparse client, the
// planner must reach them through activity_log_client_id_at_idx, not by
// walking every row in time order. Two ways this failed before it passed
// (2026-10-21): a DESC NULLS LAST index the planner could not use for
// "at desc", and touchesClient ORed with older clauses, which kept any
// client index out of the plan.

const url = process.env.DATABASE_URL;
const scratch = `avel_client_index_${process.pid}`;
const BUDGET_MS = 120_000;
const INDEX = "activity_log_client_id_at_idx";

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

const uuid = (prefix: string, n: number) =>
	`${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!url)("the client activity index", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
	let conn: ReturnType<typeof postgres> | undefined;

	afterAll(async () => {
		await conn?.end();
		await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
		await admin?.end();
	}, BUDGET_MS);

	it(
		"serves a client's list and lastActivityAt from the client index, busy client or sparse",
		async () => {
			if (!url || !admin) return;
			await admin.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin.unsafe(`create database ${scratch}`);
			conn = postgres(withDatabase(url, scratch), {
				max: 1,
				onnotice: () => {},
			});
			await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
			const db = drizzle(conn);

			await conn.unsafe(`
				insert into client (id, name, status, created_at, updated_at)
					select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'C' || g, 'active', now(), now()
					from generate_series(1, 201) g;
				insert into activity_log (id, at, actor_kind, action, entity_type, entity_id, client_id, request_id, payload)
					select gen_random_uuid(), now() - (g || ' seconds')::interval, 'system', 'client.updated', 'client',
						('00000000-0000-4000-8000-' || lpad((g % 200 + 1)::text, 12, '0'))::uuid,
						('00000000-0000-4000-8000-' || lpad((g % 200 + 1)::text, 12, '0'))::uuid, 'r', '{}'
					from generate_series(1, 200000) g;
				-- Client 201 is sparse: 20 rows, older than everyone else's.
				insert into activity_log (id, at, actor_kind, action, entity_type, entity_id, client_id, request_id, payload)
					select gen_random_uuid(), now() - interval '30 days' - (g || ' seconds')::interval, 'system', 'client.updated', 'client',
						'00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000201', 'r', '{}'
					from generate_series(1, 20) g;
				analyze;`);

			for (const clientId of [uuid("00000000", 7), uuid("00000000", 201)]) {
				const where = touchesClient(sql`${clientId}::uuid`);
				const list = db
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(where)
					.orderBy(desc(activityLog.at), desc(activityLog.id))
					.limit(51)
					.toSQL();
				const last = sql`select max("activity_log"."at") from "activity_log" where ${where}`;
				const plans = [
					await conn.unsafe(`explain ${list.sql}`, list.params as never[]),
					await db.execute(sql`explain ${last}`),
				].map((rows) =>
					(rows as unknown as Record<string, string>[])
						.map((r) => r["QUERY PLAN"])
						.join("\n"),
				);
				for (const plan of plans) {
					expect(plan, plan).toContain(
						`Index Only Scan Backward using ${INDEX}`,
					);
					expect(plan, plan).not.toMatch(/Sort/);
				}
			}
		},
		BUDGET_MS,
	);
});
