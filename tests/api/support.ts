import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import { closeDb, getDb } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { activityLog, user } from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import { type Tx, withTx } from "../../src/db/tx";
import type { RepoSource } from "../../src/gateways/repo-source";
import {
	noTemplates,
	type TemplateSource,
} from "../../src/gateways/template-source";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, randomIds, sequentialIds } from "../../src/lib/ids";
import { noRepos } from "../unit/repo-fixtures";
import {
	BASE_URL,
	captureLogger,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "../unit/support";

// Helpers for the API tests, which run the whole app against avel_test.
// Not collected as a test file.

export const clock = fixedClock("2026-10-05T12:00:00.000Z");

class Rollback extends Error {}

/** A random first uuid block, so concurrent test files never share ids. */
function namespace(): string {
	return randomIds.next().slice(0, 8);
}

/** The same generator, with its leading 00000000 block replaced by `ns`. */
function reprefix(ids: IdGenerator, ns: string): IdGenerator {
	return { next: () => ids.next().replace(/^00000000/, ns) };
}

/** Sequential uuids under their own first block, so generators sharing a database never collide. */
export function prefixedIds(prefix: string): IdGenerator {
	const inner = sequentialIds();
	return { next: () => inner.next().replace(/^00000000/, prefix) };
}

/**
 * Every SQL statement sent on the counting connection, in order. withApi
 * uses that connection when asked with `countStatements`, so a test can
 * assert how many queries one request sends.
 */
export const statements: string[] = [];
let counting: ReturnType<typeof postgres> | undefined;

function countingDb() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");
	counting ??= postgres(url, {
		max: 1,
		onnotice: () => {},
		debug: (_connection, query) => {
			statements.push(query);
		},
	});
	return drizzle(counting, { schema });
}

/** For afterAll: closes the shared pool and the counting connection, if one was opened. */
export async function closeApi() {
	await counting?.end();
	counting = undefined;
	await closeDb();
}

export type ApiHarness = {
	tx: Tx;
	app: ReturnType<typeof createApp>;
	/** This call's id namespace: every app id is `${ns}-0000-4000-8000-<n>`. */
	ns: string;
	/** The GitHub profile this call signs in as, unique to the call. */
	operator: typeof OPERATOR;
	/** Signs the operator in through the real OAuth flow; returns the session cookie. */
	signIn: () => Promise<string>;
	/** The signed-in operator's user id. Call after signIn. */
	operatorId: () => Promise<string>;
	/** A request with the session cookie and the app's origin. */
	call: (
		path: string,
		init?: { method?: string; body?: unknown },
	) => Promise<Response>;
	logRows: (
		entityId: string,
	) => Promise<Array<typeof activityLog.$inferSelect>>;
};

/**
 * Builds the app on one open transaction and rolls it back afterwards, so a
 * test leaves no rows behind, the append-only activity_log included. Each
 * handler's own withTx nests as a savepoint, so a failed mutation rolls back
 * on its own and the test can look at what is left.
 */
export async function withApi(
	fn: (h: ApiHarness) => Promise<void>,
	options: {
		ids?: IdGenerator;
		operators?: string[];
		/** Dev preview on. */
		preview?: boolean;
		/** Run on the counting connection, recording every statement in `statements`. */
		countStatements?: boolean;
		/** Where read-repo gets repositories. Default: none, and a read fails loudly. */
		repos?: RepoSource;
		/** Where the template route reads repositories. Default: none listed. */
		templates?: TemplateSource;
	} = {},
) {
	const db = options.countStatements ? countingDb() : getDb();
	// Test files run in parallel, each in a transaction that never commits.
	// Two of them inserting the same primary key or unique value (an id, the
	// operator's GitHub id or email) wait on each other's uncommitted rows
	// until one rolls back, and under load that wait outlasts a test's
	// timeout. So each call gets its own namespace: the ids stay sequential
	// (predictable within a test) under a random first block, and the
	// operator gets its own GitHub id and email.
	const ns = namespace();
	const authNs = namespace();
	const operator = {
		...OPERATOR,
		id: Number.parseInt(authNs, 16),
		email: `operator-${authNs}@example.com`,
	};
	await withTx(db, async (tx) => {
		const ids = reprefix(options.ids ?? sequentialIds(), ns);
		const { logger } = captureLogger();
		const config = testAuthConfig(options.operators ?? [String(operator.id)]);
		// Auth ids must not collide with the app's sequential ids in one database.
		const authOnlyIds = prefixedIds(authNs);
		const auth = createAuth({
			config,
			database: drizzleAdapter(tx, { provider: "pg", schema: authSchema }),
			ids: authOnlyIds,
			logger,
			recordSignIn: signInRecorder({ db: () => tx, clock, ids: authOnlyIds }),
		});
		const app = createApp({
			clock,
			ids,
			logger,
			auth,
			db: () => tx,
			webOrigins: config.webOrigins,
			preview: options.preview ?? false,
			repos: options.repos ?? noRepos,
			templates: options.templates ?? noTemplates,
		});

		let cookie = "";
		const harness: ApiHarness = {
			tx,
			app,
			ns,
			operator,
			signIn: async () => {
				const result = await signInWithGitHub(app, operator);
				if (!result.cookie)
					throw new Error(`sign-in failed: ${result.location}`);
				cookie = result.cookie;
				return cookie;
			},
			operatorId: async () => {
				const [operator] = await tx.select({ id: user.id }).from(user);
				if (!operator) throw new Error("no operator: call signIn first");
				return operator.id;
			},
			call: async (path, init = {}) =>
				app.request(path, {
					method: init.method ?? "GET",
					headers: {
						cookie,
						origin: BASE_URL,
						...(init.body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				}),
			logRows: (entityId) =>
				tx.select().from(activityLog).where(eq(activityLog.entityId, entityId)),
		};
		await fn(harness);
		throw new Rollback();
	}).catch((e: unknown) => {
		if (!(e instanceof Rollback)) throw e;
	});
}

/** Answers `fail` on the nth call and sequential uuids otherwise. */
export function idsFailingAt(n: number, fail = "not-a-uuid"): IdGenerator {
	const inner = sequentialIds();
	let calls = 0;
	return {
		next: () => {
			calls += 1;
			const id = inner.next();
			return calls === n ? fail : id;
		},
	};
}
