import type { getDb } from "./client";

export type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The pool or an open transaction. Repositories take this, so they compose inside withTx. */
export type Executor = Db | Tx;

/**
 * Runs `fn` in one transaction: commit when it returns, roll back when it throws.
 *
 * A mutation and its ActivityLog row go through the same `tx`, so neither can
 * land without the other. Called with a `tx` that is already open, it nests as
 * a savepoint: an inner failure undoes only the inner writes.
 */
export function withTx<T>(
	db: Executor,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return db.transaction(fn);
}
