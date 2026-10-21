import { eq } from "drizzle-orm";
import { type BlobStore, parseBlobKey } from "../gateways/blob";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/logger";
import { lockBlobKey } from "./blob-lock";
import { clientIdOfClient } from "./client-id";
import { file } from "./schema";
import { type Executor, type Tx, withClientScope, withTx } from "./tx";

/**
 * The orphan sweep. An upload writes its bytes inside its transaction, just
 * before the commit, so a commit that fails leaves bytes no file row names.
 * This removes them.
 *
 * Orphan: a key that no file row names in storage_key. A removed (soft-
 * deleted) row still names its bytes; a purged row names none. Only keys
 * whose bytes were written before the grace are candidates, and each one is
 * decided under the key's lock (lockBlobKey), the lock an upload holds from
 * before its put until its commit. The grace alone would not do: a put of
 * bytes already stored writes nothing, so an orphan's bytes can be old while
 * an upload that names them is in flight. Under the lock that upload has
 * either committed, and its row is seen, or not started its put, and puts
 * the bytes again after. The same decide-after-lock as the purge.
 *
 * Each key's rows are read under its client's scope (row-level security);
 * `general` keys are visible without one. Removals go to the logger, not the
 * activity log: an orphan has no entity to log against.
 */

/** [hypothesis] Far longer than any upload's transaction. Not measured. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** [hypothesis] Orphans are rare, and nothing waits on their removal. */
export const ORPHAN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Keys decided per sweep, so one sweep's work stays bounded. */
export const ORPHAN_SWEEP_BATCH = 500;

export type BlobSweepDeps = {
	db: () => Executor;
	clock: Clock;
	blobs: BlobStore;
	logger: Logger;
};

export type BlobSweepResult = {
	/** Keys removed, in key order. */
	removed: string[];
	/** Candidates past the grace that a row still names, or whose client is unknown. */
	kept: number;
	/** Temporary files of dead puts removed. */
	temps: number;
};

export async function sweepOrphanBlobs(
	deps: BlobSweepDeps,
): Promise<BlobSweepResult> {
	const before = new Date(deps.clock.now().getTime() - ORPHAN_GRACE_MS);
	const temps = await deps.blobs.removeStaleTemps(before);
	const candidates = (await deps.blobs.list())
		.filter((e) => e.writtenAt < before)
		.slice(0, ORPHAN_SWEEP_BATCH)
		.map((e) => e.key);
	const removed: string[] = [];
	for (const key of candidates) {
		if (await removeIfOrphan(deps, key)) {
			deps.logger.info({ key }, "orphan blob removed");
			removed.push(key);
		}
	}
	return { removed, kept: candidates.length - removed.length, temps };
}

async function removeIfOrphan(
	deps: BlobSweepDeps,
	key: string,
): Promise<boolean> {
	const decide = async (tx: Tx) => {
		await lockBlobKey(tx, key);
		const [named] = await tx
			.select({ id: file.id })
			.from(file)
			.where(eq(file.storageKey, key))
			.limit(1);
		if (named) return false;
		await deps.blobs.remove(key);
		return true;
	};
	const db = deps.db();
	const { prefix } = parseBlobKey(key);
	if (prefix === "general") return withTx(db, decide);
	const clientId = await clientIdOfClient(db, prefix.slice("clients/".length));
	if (!clientId) {
		// Every client row is kept (soft delete only), so a key with none
		// was not written by an upload. Left for an operator to look at.
		deps.logger.warn({ key }, "orphan sweep: no client for this key; kept");
		return false;
	}
	return withTx(db, (tx) => withClientScope(tx, clientId, decide));
}
