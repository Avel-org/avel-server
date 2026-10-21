import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import { sweepOrphanBlobs } from "../../src/db/blob-sweep";
import { dispatchByTokenSha256 } from "../../src/db/dispatch";
import * as schema from "../../src/db/schema";
import { client, engagement, intake } from "../../src/db/schema";
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
import { gated } from "./race-support";

// An upload and a purge of the same bytes race. Keys are per client and
// named by the bytes' hash, so a second upload of a file's bytes shares the
// first one's key. The purge removes the bytes unless another row still
// names the key, and an uncommitted upload's row is invisible to it. Both
// take the key's advisory lock (lockBlobKey in src/db/blob-lock.ts), so a
// purge that arrives while the upload is uncommitted waits, then sees the
// new row and keeps the bytes. The orphan sweep (src/db/blob-sweep.ts)
// takes the same lock and decides the same way. Two committed transactions,
// so this file gets a throwaway database, as tests/api/file-purge-race.test.ts
// does.

const url = process.env.DATABASE_URL;
const scratch = `avel_upload_purge_race_${process.pid}`;
const BUDGET_MS = 60_000;
const clock = fixedClock("2026-10-05T12:00:00.000Z");
const BYTES = "# Brief\n";
const HOUR = 60 * 60 * 1000;

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

function prefixedIds(prefix: string): IdGenerator {
	const inner = sequentialIds();
	return { next: () => inner.next().replace(/^00000000/, prefix) };
}

/**
 * Resolves "waits" once some backend in `database` waits on a lock, or
 * "settled" if `request` finishes first, which it does only when nothing
 * made it wait.
 */
async function waitsOrSettles(
	admin: ReturnType<typeof postgres>,
	database: string,
	request: Promise<unknown>,
): Promise<"waits" | "settled"> {
	let settled = false;
	void request.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let attempt = 0; attempt < 5_000; attempt++) {
		if (settled) return "settled";
		const [row] = await admin<{ n: number }[]>`
			select count(*)::int as n from pg_stat_activity
			where datname = ${database} and wait_event_type = 'Lock'`;
		if ((row?.n ?? 0) > 0) return "waits";
	}
	throw new Error("the request neither waited on a lock nor finished");
}

describe.skipIf(!url)(
	"an upload and a purge of the same bytes, on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		const files = tempDir("upload-purge-race");
		// Written at the test's clock, so the sweep below can be hours later.
		const blobs = memoryBlobs(clock);
		let conn: ReturnType<typeof postgres> | undefined;
		let db: Db;
		let first: ReturnType<typeof gated>;
		let callFirst: (p: string, init?: RequestInit) => Promise<Response>;
		let callSecond: (p: string, init?: RequestInit) => Promise<Response>;
		const seedIds = prefixedIds("66666666");

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
			const appFor = (database: Db, prefix: string) =>
				createApp({
					clock,
					ids: prefixedIds(prefix),
					logger,
					auth,
					db: () => database,
					webOrigins: [],
					preview: false,
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
			const firstApp = appFor(first.db, "11111111");
			const secondApp = appFor(db, "22222222");
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

		/** A client, its engagement and an intake, committed. */
		async function seedIntake() {
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
			return { clientId, intakeId };
		}

		const upload = (call: typeof callFirst, intakeId: string, name: string) =>
			call(`/api/intakes/${intakeId}/files?name=${name}`, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: BYTES,
			});

		it(
			"a purge that arrives while an upload of the same bytes is uncommitted waits, then keeps the bytes the upload still names",
			async () => {
				const { intakeId } = await seedIntake();
				const old = await upload(callSecond, intakeId, "a.md");
				expect(old.status, await old.clone().text()).toBe(201);
				const oldId = ((await old.json()) as { data: { id: string } }).data.id;

				// The second upload has put its bytes and holds its commit.
				const gate = first.holdNext();
				const uploading = upload(callFirst, intakeId, "b.md");
				await gate.reached;
				const purging = callSecond(`/api/intakes/${intakeId}/files/${oldId}`, {
					method: "DELETE",
				});
				const outcome = await waitsOrSettles(
					admin as NonNullable<typeof admin>,
					scratch,
					purging,
				).finally(() => gate.release());

				const uploaded = await uploading;
				expect(uploaded.status, await uploaded.clone().text()).toBe(201);
				const newId = ((await uploaded.json()) as { data: { id: string } }).data
					.id;
				expect((await purging).status).toBe(200);
				const read = await callSecond(
					`/api/intakes/${intakeId}/files/${newId}/content`,
				);
				expect(read.status, await read.clone().text()).toBe(200);
				expect(await read.text()).toBe(BYTES);
				expect(blobs.keys()).toHaveLength(1);
				expect(outcome).toBe("waits");
			},
			BUDGET_MS,
		);

		it(
			"the orphan sweep waits on an upload in flight that names old orphaned bytes, then keeps them",
			async () => {
				const { clientId, intakeId } = await seedIntake();
				// Bytes no row names, written at the clock: hours old to the sweep.
				const { key } = await blobs.put(
					`clients/${clientId}`,
					new TextEncoder().encode(BYTES),
				);

				// The upload of the same bytes has put them (a no-op: they exist)
				// and holds its commit.
				const gate = first.holdNext();
				const uploading = upload(callFirst, intakeId, "c.md");
				await gate.reached;
				const sweeping = sweepOrphanBlobs({
					db: () => db,
					clock: { now: () => new Date(clock.now().getTime() + 2 * HOUR) },
					blobs,
					logger: captureLogger().logger,
				});
				const outcome = await waitsOrSettles(
					admin as NonNullable<typeof admin>,
					scratch,
					sweeping,
				).finally(() => gate.release());

				const uploaded = await uploading;
				expect(uploaded.status, await uploaded.clone().text()).toBe(201);
				const fileId = ((await uploaded.json()) as { data: { id: string } })
					.data.id;
				expect((await sweeping).removed).not.toContain(key);
				const read = await callSecond(
					`/api/intakes/${intakeId}/files/${fileId}/content`,
				);
				expect(read.status, await read.clone().text()).toBe(200);
				expect(await read.text()).toBe(BYTES);
				expect(outcome).toBe("waits");
			},
			BUDGET_MS,
		);
	},
);
