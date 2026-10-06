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
