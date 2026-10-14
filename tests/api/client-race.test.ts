import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import {
	clientSchema,
	errorEnvelope,
	successEnvelope,
} from "../../src/contract";
import * as schema from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import type { Db } from "../../src/db/tx";
import { noTemplates } from "../../src/gateways/template-source";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";
import { noDispatches } from "../../src/middleware/caller";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { noRepos } from "../unit/repo-fixtures";
import {
	BASE_URL,
	captureLogger,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "../unit/support";

// The close-client rule races engagement create: a client must never end up
// closed with an active engagement. Proving that takes two real, committed
// transactions on two connections, so this file gets a throwaway database of
// its own (the activity_log rows it commits could never be cleaned from the
// shared one). The pattern is tests/db/migrate-from-empty.test.ts's.
//
// Ordering is driven by conditions, never sleeps: a wrapped database holds
// one handler's transaction open after its work and before its commit, and
// the test waits until Postgres reports the other backend waiting on a lock.

const url = process.env.DATABASE_URL;
const scratch = `avel_client_race_${process.pid}`;
const BUDGET_MS = 60_000;

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

/** Sequential uuids under their own first block, so two generators never collide. */
function prefixedIds(prefix: string): IdGenerator {
	const inner = sequentialIds();
	return { next: () => inner.next().replace(/^00000000/, prefix) };
}

/**
 * The database, with a gate on the next transaction: once its work is done
 * and before it commits, it signals `reached` and waits for `release`. It
 * keeps every lock it took for as long as it waits.
 */
function gated(db: Db) {
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

describe.skipIf(!url)(
	"close-client vs engagement create, on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		let conn: ReturnType<typeof postgres> | undefined;
		let closer: ReturnType<typeof gated>;
		let creator: ReturnType<typeof gated>;
		let call: (
			app: "closer" | "creator",
			path: string,
			init?: { method?: string; body?: unknown },
		) => Promise<Response>;

		/** Resolves once some backend in the scratch database is waiting on a lock. */
		async function someoneWaitsOnALock() {
			for (let attempt = 0; attempt < 5_000; attempt++) {
				const [row] = await (admin as NonNullable<typeof admin>)<
					{ n: number }[]
				>`
				select count(*)::int as n from pg_stat_activity
				where datname = ${scratch} and wait_event_type = 'Lock'`;
				if ((row?.n ?? 0) > 0) return;
			}
			throw new Error(
				"no transaction ever blocked on a lock: the race was not exercised",
			);
		}

		async function newClient() {
			const res = await call("creator", "/api/clients", {
				method: "POST",
				body: { name: "Meridian" },
			});
			expect(res.status).toBe(201);
			return successEnvelope(clientSchema).parse(await res.json()).data.id;
		}

		beforeAll(async () => {
			if (!url || !admin) return;
			await admin.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin.unsafe(`create database ${scratch}`);
			conn = postgres(withDatabase(url, scratch), {
				max: 6,
				onnotice: () => {},
			});
			await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
			const db: Db = drizzle(conn, { schema });

			const clock = fixedClock("2026-10-05T12:00:00.000Z");
			const { logger } = captureLogger();
			const config = testAuthConfig([String(OPERATOR.id)]);
			const authIds = prefixedIds("aaaaaaaa");
			const auth = createAuth({
				config,
				database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
				ids: authIds,
				logger,
				recordSignIn: signInRecorder({ db: () => db, clock, ids: authIds }),
			});
			closer = gated(db);
			creator = gated(db);
			const apps = {
				closer: createApp({
					clock,
					ids: prefixedIds("11111111"),
					logger,
					auth,
					db: () => closer.db,
					webOrigins: [],
					preview: false,
					repos: noRepos,
					templates: noTemplates,
					dispatchByToken: noDispatches,
					runnerCredentialSha256: null,
					harness: new FakeHarness(),
					prices: DEFAULT_PRICE_BOOK,
				}),
				creator: createApp({
					clock,
					ids: prefixedIds("22222222"),
					logger,
					auth,
					db: () => creator.db,
					webOrigins: [],
					preview: false,
					repos: noRepos,
					templates: noTemplates,
					dispatchByToken: noDispatches,
					runnerCredentialSha256: null,
					harness: new FakeHarness(),
					prices: DEFAULT_PRICE_BOOK,
				}),
			};
			const { cookie } = await signInWithGitHub(apps.creator, OPERATOR);
			if (!cookie) throw new Error("sign-in failed in the scratch database");
			call = async (app, path, init = {}) =>
				apps[app].request(path, {
					method: init.method ?? "GET",
					headers: {
						cookie,
						origin: BASE_URL,
						...(init.body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				});
		}, BUDGET_MS);

		afterAll(async () => {
			await conn?.end();
			await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin?.end();
		}, BUDGET_MS);

		it(
			"close first: a create that starts while the close is uncommitted blocks, then gets 422 client_closed",
			async () => {
				const clientId = await newClient();

				// T1: the close does its work and holds its transaction open.
				const gate = closer.holdNext();
				const closing = call("closer", `/api/clients/${clientId}`, {
					method: "PATCH",
					body: { status: "closed" },
				});
				await gate.reached;

				// T2: the create must block on the client row while T1 holds it.
				const creating = call("creator", "/api/engagements", {
					method: "POST",
					body: { clientId, name: "Too late" },
				});
				// If nothing ever blocks, release T1 before failing: a transaction
				// left open past afterAll would orphan the scratch database.
				await someoneWaitsOnALock().catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await closing).status).toBe(200);
				const created = await creating;
				expect(created.status).toBe(422);
				expect(
					errorEnvelope.parse(await created.json()).error.details,
				).toMatchObject({
					reason: "client_closed",
				});
			},
			BUDGET_MS,
		);

		it(
			"create first: a close that starts while the create is uncommitted blocks, then gets 422 client_has_active_engagements",
			async () => {
				const clientId = await newClient();

				// T2: the create does its work and holds its transaction open.
				const gate = creator.holdNext();
				const creating = call("creator", "/api/engagements", {
					method: "POST",
					body: { clientId, name: "In time" },
				});
				await gate.reached;

				// T1: the close must block on the client row while T2 holds it.
				const closing = call("closer", `/api/clients/${clientId}`, {
					method: "PATCH",
					body: { status: "closed" },
				});
				// If nothing ever blocks, release T1 before failing: a transaction
				// left open past afterAll would orphan the scratch database.
				await someoneWaitsOnALock().catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await creating).status).toBe(201);
				const closed = await closing;
				expect(closed.status).toBe(422);
				expect(
					errorEnvelope.parse(await closed.json()).error.details,
				).toMatchObject({
					reason: "client_has_active_engagements",
				});
			},
			BUDGET_MS,
		);
	},
);
