import { type SQL, sql } from "drizzle-orm";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { activityLog } from "./schema/activity";
import type { Tx } from "./tx";

export type ActivityEntry = Omit<typeof activityLog.$inferInsert, "id" | "at">;

/**
 * Writes one ActivityLog row. It takes a `Tx`, never the pool, so it can only
 * run inside withTx, in the same transaction as the mutation it records: if
 * the mutation rolls back, so does its log row.
 */
export async function logActivity(
	tx: Tx,
	deps: { clock: Clock; ids: IdGenerator },
	entry: ActivityEntry,
) {
	const row = { id: deps.ids.next(), at: deps.clock.now(), ...entry };
	await tx.insert(activityLog).values(row);
	return row;
}

/**
 * ActivityLog rows that touch one client: the client's own rows, rows on its
 * memory (which carry no engagement or mission), and rows on any of its
 * engagements or their missions, deleted ones included, since the activity
 * happened. Written table-qualified with its own aliases, so it binds
 * correctly inside a correlated subquery; `clientId` may be a bound value or
 * an outer column.
 */
export function touchesClient(clientId: SQL): SQL {
	return sql`(
		("activity_log"."entity_type" = 'client' and "activity_log"."entity_id" = ${clientId})
		or ("activity_log"."entity_type" = 'client_memory' and "activity_log"."entity_id" in (
			select "tc_cm"."id" from "client_memory" "tc_cm" where "tc_cm"."client_id" = ${clientId}
		))
		or "activity_log"."engagement_id" in (
			select "tc_e"."id" from "engagement" "tc_e" where "tc_e"."client_id" = ${clientId}
		)
		or "activity_log"."mission_id" in (
			select "tc_m"."id" from "mission" "tc_m"
			join "engagement" "tc_me" on "tc_me"."id" = "tc_m"."engagement_id"
			where "tc_me"."client_id" = ${clientId}
		)
	)`;
}
