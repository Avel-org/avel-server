import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import { dispatchByTokenSha256 } from "../../src/db/dispatch";
import * as schema from "../../src/db/schema";
import { activityLog, client, engagement, intake } from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import { stamp } from "../../src/db/schema/columns";
import type { Db } from "../../src/db/tx";
import { memoryBlobs } from "../../src/gateways/blob";
import { noTemplates } from "../../src/gateways/template-source";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../../src/routes/files";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { removeDir, tempDir } from "../unit/git-fixtures";
import { noRepos } from "../unit/repo-fixtures";
import {
	BASE_URL,
	captureLogger,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "../unit/support";
import { gated, someoneWaitsOnALock } from "./race-support";

// Two purges of one file race. Both read the row unpurged, then queue on
// the storage key's lock; the loser must decide again after the lock, find
// the file purged, and answer the idempotent 200 instead of updating a
// tombstone (which the file_immutable trigger refuses with a 500). Proving
// it takes two committed transactions, so this file gets a throwaway
// database, and orders them by lock waits.

const url = process.env.DATABASE_URL;
const scratch = `avel_purge_race_${process.pid}`;
const BUDGET_MS = 60_000;
const clock = fixedClock("2026-10-05T12:00:00.000Z");

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

function prefixedIds(prefix: string): IdGenerator {
	const inner = sequentialIds();
	return { next: () => inner.next().replace(/^00000000/, prefix) };
}

describe.skipIf(!url)(
	"two purges of one file, on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		const files = tempDir("purge-race");
		let conn: ReturnType<typeof postgres> | undefined;
		let db: Db;
		let first: ReturnType<typeof gated>;
		let second: ReturnType<typeof gated>;
		let callFirst: (p: string, init?: RequestInit) => Promise<Response>;
		let callSecond: (p: string, init?: RequestInit) => Promise<Response>;
		const seedIds = prefixedIds("55555555");

		beforeAll(async () => {
			if (!url || !admin) return;
			await admin.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin.unsafe(`create database ${scratch}`);
			conn = postgres(withDatabase(url, scratch), {
				max: 6,
				onnotice: () => {},
			});
			await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
			db = drizzle(conn, { schema });

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
			first = gated(db);
			second = gated(db);
			const blobs = memoryBlobs();
			const appFor = (gate: ReturnType<typeof gated>, prefix: string) =>
				createApp({
					clock,
					ids: prefixedIds(prefix),
					logger,
					auth,
					db: () => gate.db,
					webOrigins: [],
					repos: noRepos,
					templates: noTemplates,
					dispatchByToken: dispatchByTokenSha256,
					runnerCredentialSha256: null,
					harness: new FakeHarness(),
					prices: DEFAULT_PRICE_BOOK,
					rooms: worktreeRooms(`${files}/rooms`),
					roomSources: localSources(`${files}/sources`),
					drive: { blobs, maxBytes: DEFAULT_UPLOAD_MAX_BYTES },
				});
			const firstApp = appFor(first, "11111111");
			const secondApp = appFor(second, "22222222");
			const { cookie } = await signInWithGitHub(firstApp, OPERATOR);
			if (!cookie) throw new Error("sign-in failed in the scratch database");
			const headers = { cookie, origin: BASE_URL };
			callFirst = async (p, init = {}) =>
				firstApp.request(p, {
					...init,
					headers: { ...headers, ...init.headers },
				});
			callSecond = async (p, init = {}) =>
				secondApp.request(p, {
					...init,
					headers: { ...headers, ...init.headers },
				});
		}, BUDGET_MS);

		afterAll(async () => {
			await conn?.end();
			await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin?.end();
			removeDir(files);
		}, BUDGET_MS);

		it(
			"the second purge waits on the key, then answers 200 with the tombstone and logs nothing",
			async () => {
				const clientId = seedIds.next();
				const engagementId = seedIds.next();
				const intakeId = seedIds.next();
				await db.insert(client).values({
					id: clientId,
					name: "Meridian",
					status: "active",
					...stamp(clock),
				});
				await db.insert(engagement).values({
					id: engagementId,
					clientId,
					name: "App",
					status: "active",
					startedAt: clock.now(),
					...stamp(clock),
				});
				await db.insert(intake).values({
					id: intakeId,
					engagementId,
					status: "draft",
					sourceMd: "# Brief",
					openQuestions: [],
					...stamp(clock),
				});
				const uploaded = await callFirst(
					`/api/intakes/${intakeId}/files?name=a.md`,
					{
						method: "POST",
						headers: { "content-type": "text/plain" },
						body: "# Brief\n",
					},
				);
				expect(uploaded.status, await uploaded.clone().text()).toBe(201);
				const fileId = ((await uploaded.json()) as { data: { id: string } })
					.data.id;
				const purgePath = `/api/intakes/${intakeId}/files/${fileId}`;

				const gate = first.holdNext();
				const purging = callFirst(purgePath, { method: "DELETE" });
				await gate.reached;
				const again = callSecond(purgePath, { method: "DELETE" });
				await someoneWaitsOnALock(
					admin as NonNullable<typeof admin>,
					scratch,
				).catch((e: unknown) => {
					gate.release();
					throw e;
				});
				gate.release();

				const won = await purging;
				expect(won.status).toBe(200);
				const lost = await again;
				expect(lost.status, await lost.clone().text()).toBe(200);
				const wonBody = (await won.json()) as { data: { purgedAt: string } };
				const lostBody = (await lost.json()) as { data: { purgedAt: string } };
				expect(lostBody.data.purgedAt).toBe(wonBody.data.purgedAt);
				const logged = await db
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.action, "file.purged"),
							eq(activityLog.entityId, fileId),
						),
					);
				expect(logged).toHaveLength(1);
			},
			BUDGET_MS,
		);
	},
);
