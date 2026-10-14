import type postgres from "postgres";
import type { Db } from "../../src/db/tx";

// Two committed transactions, ordered by lock waits, never by sleeps: the
// pattern of tests/api/client-race.test.ts and playbook-start-race.test.ts.
// Not collected as a test file.

/**
 * The database, with a gate on the next transaction: once its work is done
 * and before it commits, it signals `reached` and waits for `release`,
 * holding every lock it took.
 */
export function gated(db: Db) {
	let armed: { reached: () => void; release: Promise<void> } | null = null;
	const proxy = new Proxy(db, {
		get(target, prop) {
			if (prop === "transaction") {
				const transaction: Db["transaction"] = (fn, config) =>
					target.transaction(async (tx) => {
						const result = await fn(tx);
						const gate = armed;
						armed = null;
						if (gate) {
							gate.reached();
							await gate.release;
						}
						return result;
					}, config);
				return transaction;
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		db: proxy,
		holdNext() {
			let reached!: () => void;
			let release!: () => void;
			const reachedP = new Promise<void>((r) => {
				reached = r;
			});
			const releaseP = new Promise<void>((r) => {
				release = r;
			});
			armed = { reached, release: releaseP };
			return { reached: reachedP, release };
		},
	};
}

/** Resolves once some backend in `database` waits on a lock; throws if none ever does. */
export async function someoneWaitsOnALock(
	admin: ReturnType<typeof postgres>,
	database: string,
) {
	for (let attempt = 0; attempt < 5_000; attempt++) {
		const [row] = await admin<{ n: number }[]>`
			select count(*)::int as n from pg_stat_activity
			where datname = ${database} and wait_event_type = 'Lock'`;
		if ((row?.n ?? 0) > 0) return;
	}
	throw new Error(
		"no transaction ever blocked on a lock: the race was not exercised",
	);
}
