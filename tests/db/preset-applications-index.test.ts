import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { presetApplicationQueries } from "../../src/routes/presets";
import { encodeCursor } from "../../src/routes/shared";
import { onScratchDatabase } from "./scratch";

// GET /api/presets/:id/applications filters activity_log on the action and
// payload->>'presetId'. activity_log_preset_applied_idx (drizzle/0046) is
// keyed on exactly those, over the rows whose payload names a preset. This
// EXPLAINs the route's own two queries on enough rows that the planner picks
// an index on merit, under a generic plan: what a prepared statement reused
// past five runs may get, with the preset id still a parameter. On a
// database of its own, so ANALYZE sees only these rows.

const ROWS = 40_000;
const PRESETS = 200;
const presetId = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Applied 4000 times: its page is cheaper read in the index's order than
// sorted. The others are applied about 20 times each.
const HOT = presetId(1);
const COLD = presetId(7);

type PlanNode = {
	"Node Type": string;
	"Index Name"?: string;
	Plans?: PlanNode[];
};

function nodes(plan: PlanNode): PlanNode[] {
	return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function literal(value: unknown): string {
	if (typeof value === "number") return String(value);
	return `'${String(value).replaceAll("'", "''")}'`;
}

/** The generic plan of `sql`, prepared as the route's statement would be. */
async function genericPlan(
	conn: postgres.Sql,
	built: { sql: string; params: unknown[] },
): Promise<PlanNode> {
	await conn.unsafe(`prepare q as ${built.sql}`);
	try {
		const [row] = await conn.unsafe<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
			`explain (format json) execute q(${built.params.map(literal).join(", ")})`,
		);
		const plan = row?.["QUERY PLAN"][0].Plan;
		if (!plan) throw new Error("no plan");
		return plan;
	} finally {
		await conn.unsafe("deallocate q");
	}
}

describe.skipIf(!process.env.DATABASE_URL)(
	"the preset applications index",
	() => {
		it("serves the route's page and total under a generic plan, and a busy preset's page in order", async () => {
			await onScratchDatabase("preset_index", async (conn) => {
				// One row in five is an application: every other one of the hot
				// preset, the rest spread over the others. The other rows are
				// another action, whose payload has no presetId.
				await conn`
					insert into activity_log (id, at, actor_kind, action, entity_type, entity_id, request_id, payload)
					select
						gen_random_uuid(),
						'2026-10-01T00:00:00Z'::timestamptz + make_interval(secs => i),
						'system',
						(case when i % 5 = 0 then 'roster.preset_applied' else 'client.created' end)::activity_action,
						(case when i % 5 = 0 then 'mission' else 'client' end)::activity_entity_type,
						gen_random_uuid(),
						'req-' || i,
						case
							when i % 10 = 0 then jsonb_build_object('presetId', ${HOT}::text)
							when i % 5 = 0 then jsonb_build_object('presetId', '00000000-0000-4000-8000-' || lpad((2 + (i / 10) % ${PRESETS})::text, 12, '0'))
							else jsonb_build_object('name', 'c' || i)
						end
					from generate_series(1, ${ROWS}) as i`;
				await conn`analyze activity_log`;
				await conn`set plan_cache_mode = force_generic_plan`;

				const db = drizzle(conn, { schema });
				const cursor = encodeCursor({
					createdAt: new Date("2026-10-01T05:00:00Z"),
					id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
				});
				for (const preset of [HOT, COLD]) {
					for (const query of [{ limit: 50 }, { limit: 50, cursor }]) {
						const q = presetApplicationQueries(db, preset, query);
						for (const [name, built] of [
							["page", q.rows.toSQL()],
							["total", q.count.toSQL()],
						] as const) {
							const plan = await genericPlan(conn, built);
							const label = `${name} of ${preset} ${JSON.stringify(query)}`;
							// Generic: the preset id stays a parameter in the plan.
							expect(JSON.stringify(plan), label).toContain("$1");
							const all = nodes(plan);
							expect(
								all.map((n) => n["Index Name"]).filter(Boolean),
								label,
							).toContain("activity_log_preset_applied_idx");
							if (preset === HOT && name === "page") {
								expect(
									all.map((n) => n["Node Type"]),
									label,
								).not.toContain("Sort");
							}
						}
					}
				}
			});
		}, 60_000);
	},
);
