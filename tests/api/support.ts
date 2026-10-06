import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import { getDb } from "../../src/db/client";
import { activityLog } from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import { type Tx, withTx } from "../../src/db/tx";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";
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

export type ApiHarness = {
	tx: Tx;
	app: ReturnType<typeof createApp>;
	/** Signs the operator in through the real OAuth flow; returns the session cookie. */
	signIn: () => Promise<string>;
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
	options: { ids?: IdGenerator; operators?: string[] } = {},
) {
	await withTx(getDb(), async (tx) => {
		const ids = options.ids ?? sequentialIds();
		const authIds = sequentialIds();
		const { logger } = captureLogger();
		const config = testAuthConfig(options.operators ?? [String(OPERATOR.id)]);
		// Auth ids must not collide with the app's sequential ids in one database.
		const authOnlyIds: IdGenerator = {
			next: () => authIds.next().replace(/^00000000/, "aaaaaaaa"),
		};
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
		});

		let cookie = "";
		const harness: ApiHarness = {
			tx,
			app,
			signIn: async () => {
				const result = await signInWithGitHub(app, OPERATOR);
				if (!result.cookie)
					throw new Error(`sign-in failed: ${result.location}`);
				cookie = result.cookie;
				return cookie;
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
