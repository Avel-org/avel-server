import { sql } from "drizzle-orm";
import type { getDb } from "./client";
import type { ClientId } from "./client-id";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs `fn` in one transaction scoped to one client, for the tables under
 * row-level security (drizzle/0028_drive.sql). Their policies read
 * `avel.client_id`; this sets it with `set_config(..., true)`, which lasts
 * until the transaction ends and never reaches the next transaction on the
 * same pooled connection.
 *
 * `clientId` is a ClientId, which only the lookups in src/db/client-id.ts
 * make: from the client, engagement or intake row, never a request body or
 * a model.
 *
 * Nested inside a transaction scoped to another client, it refuses: one
 * transaction never reads two clients. Nested in an unscoped transaction, it
 * runs as a savepoint and puts the outer scope back when `fn` returns.
 */
export function withClientScope<T>(
	db: Executor,
	clientId: ClientId,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	if (!UUID.test(clientId)) {
		throw new Error(`withClientScope: "${clientId}" is not a uuid`);
	}
	return db.transaction(async (tx) => {
		const [outer] = await tx.execute<{ scope: string | null }>(
			sql`select current_setting('avel.client_id', true) as scope`,
		);
		const previous = outer?.scope ?? "";
		if (previous !== "" && previous !== clientId) {
			throw new Error(
				"withClientScope: this transaction is already scoped to another client",
			);
		}
		await tx.execute(
			sql`select set_config('avel.client_id', ${clientId}, true)`,
		);
		const result = await fn(tx);
		await tx.execute(
			sql`select set_config('avel.client_id', ${previous}, true)`,
		);
		return result;
	});
}

/**
 * Runs `fn` in one transaction scoped to no client: the scope an open Canon
 * session's rows live in (drizzle/0042). The Canon policies show a row with
 * no client only here, so inside a client's scope this refuses rather than
 * read nothing.
 */
export function withOpenScope<T>(
	db: Executor,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		const [outer] = await tx.execute<{ scope: string | null }>(
			sql`select current_setting('avel.client_id', true) as scope`,
		);
		if ((outer?.scope ?? "") !== "") {
			throw new Error(
				"withOpenScope: this transaction is already scoped to a client",
			);
		}
		return fn(tx);
	});
}

/** Where a Canon session's rows live: one client's scope, or the open one. */
export type CanonScope =
	| { kind: "client"; clientId: ClientId }
	| { kind: "open" };

/** withClientScope or withOpenScope, as the session's scope says. */
export function withCanonScope<T>(
	db: Executor,
	scope: CanonScope,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return scope.kind === "client"
		? withClientScope(db, scope.clientId, fn)
		: withOpenScope(db, fn);
}

/** The value a Canon row's client_id takes in this scope. */
export function scopeClientId(scope: CanonScope): ClientId | null {
	return scope.kind === "client" ? scope.clientId : null;
}
