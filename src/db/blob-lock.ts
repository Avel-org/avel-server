import { sql } from "drizzle-orm";
import type { Tx } from "./tx";

/**
 * One blob key at a time: an upload, a purge and the orphan sweep of the
 * same bytes never interleave. Held until the transaction ends, so an
 * upload holds it from before its put until its row commits.
 */
export async function lockBlobKey(tx: Tx, key: string) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
	);
}
