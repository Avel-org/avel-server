import { type SQL, sql } from "drizzle-orm";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { activityLog } from "./schema/activity";
import type { Tx } from "./tx";

export type ActivityEntry = Omit<
	typeof activityLog.$inferInsert,
	"id" | "at" | "clientId"
> & {
	/**
	 * The client, for a row with no engagement or mission that still belongs
	 * to one: a client's memory, a Canon session on a client. Every other
	 * row's client is found from its engagement, mission or client entity.
	 */
	clientId?: string | null;
};

/**
 * The row's client_id, worked out inside its INSERT: the given client, the
 * client entity itself, else its engagement's client, else its mission's.
 * engagement and mission carry no row-level security, so this reads the same
 * as avel_app as it does as the owner, with no extra statement.
 */
function clientIdOf(entry: ActivityEntry): SQL {
	const given =
		entry.clientId ?? (entry.entityType === "client" ? entry.entityId : null);
	const parts: SQL[] = [];
	if (given) parts.push(sql`${given}::uuid`);
	if (entry.engagementId) {
		parts.push(
			sql`(select "client_id" from "engagement" where "id" = ${entry.engagementId}::uuid)`,
		);
	}
	if (entry.missionId) {
		parts.push(sql`(
			select "ae"."client_id" from "mission" "am"
			join "engagement" "ae" on "ae"."id" = "am"."engagement_id"
			where "am"."id" = ${entry.missionId}::uuid
		)`);
	}
	if (parts.length === 0) return sql`null`;
	return sql`coalesce(${sql.join(parts, sql`, `)})`;
}

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
	const { clientId: _given, ...columns } = entry;
	const [row] = await tx
		.insert(activityLog)
		.values({
			id: deps.ids.next(),
			at: deps.clock.now(),
			...columns,
			clientId: clientIdOf(entry),
		})
		.returning();
	if (!row) throw new Error("an activity_log insert returned no row");
	return row;
}

/**
 * ActivityLog rows that touch one client: every row whose client_id is the
 * client. logActivity sets it on each row with a client, and drizzle/0047
 * backfilled the rows written before it, which the old clauses (the client
 * entity, its engagements, their missions) matched exactly. One equality, so
 * activity_log_client_id_at_idx serves both the list and max(at); an OR with
 * those clauses kept every client index out of the plan
 * (tests/db/activity-client-index.test.ts). Table-qualified, so it binds
 * correctly inside a correlated subquery; `clientId` may be a bound value or
 * an outer column.
 */
export function touchesClient(clientId: SQL): SQL {
	return sql`("activity_log"."client_id" = ${clientId})`;
}
