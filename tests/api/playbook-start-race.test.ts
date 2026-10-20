import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import { type Brief, errorEnvelope } from "../../src/contract";
import * as schema from "../../src/db/schema";
import {
	agentTemplate,
	client,
	engagement,
	mission,
	playbook,
	rosterEntry,
	rosterPreset,
} from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import { stamp } from "../../src/db/schema/columns";
import type { Db } from "../../src/db/tx";
import { memoryBlobs } from "../../src/gateways/blob";
import { noTemplates } from "../../src/gateways/template-source";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";
import { noDispatches } from "../../src/middleware/caller";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../../src/routes/files";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { noRepos } from "../unit/repo-fixtures";
import { anySource, memoryRooms } from "../unit/room-fixtures";
import {
	BASE_URL,
	captureLogger,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "../unit/support";

// playbook_in_use races mission start: a playbook must never change under
// a mission that start has just made active, and start must never pass on
// a playbook an uncommitted update is replacing. Start locks the playbook
// FOR SHARE and the update takes it FOR UPDATE before its in-use check, so
// one waits for the other. Proving it takes two committed transactions on
// two connections, so this file gets a throwaway database, as
// tests/api/client-race.test.ts does, and orders them by lock waits, never
// by sleeps.

const url = process.env.DATABASE_URL;
const scratch = `avel_playbook_race_${process.pid}`;
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

/**
 * The database, with a gate on the next transaction: once its work is done
 * and before it commits, it signals `reached` and waits for `release`,
 * holding every lock it took.
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

const PLANNED: Brief = {
	summary: "Online booking for a salon",
	requirements: [{ id: "R1", text: "A client books a slot" }],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
	],
	modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"], reads: [] }],
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "test", command: "pnpm test R1" },
	],
};

describe.skipIf(!url)(
	"mission start vs playbook update, on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		let conn: ReturnType<typeof postgres> | undefined;
		let db: Db;
		let starter: ReturnType<typeof gated>;
		let editor: ReturnType<typeof gated>;
		let call: (
			app: "starter" | "editor",
			path: string,
			init?: { method?: string; body?: unknown },
		) => Promise<Response>;
		const seedIds = prefixedIds("33333333");

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

		/**
		 * A draft mission ready to start: its playbook's first wave is B and
		 * its one agent is in B. The preset staffs A and B, so an update may
		 * move the first wave to A, which the roster cannot staff.
		 */
		async function readyMission(type: string) {
			const id = () => seedIds.next();
			const clientId = id();
			await db.insert(client).values({
				id: clientId,
				name: `Client ${type}`,
				status: "active",
				...stamp(clock),
			});
			const engagementId = id();
			await db.insert(engagement).values({
				id: engagementId,
				clientId,
				name: "Booking",
				status: "active",
				startedAt: clock.now(),
				...stamp(clock),
			});
			const templateId = id();
			await db.insert(agentTemplate).values({
				id: templateId,
				slug: `${type}-kel`,
				name: "Kel",
				kind: "feature",
				roles: ["domain"],
				waveDefaults: ["B"],
				writablePaths: ["src/**"],
				version: 1,
				...stamp(clock),
			});
			const presetId = id();
			await db.insert(rosterPreset).values({
				id: presetId,
				name: `Preset ${type}`,
				description: null,
				cut: "vertical",
				agents: [{ agent_template_id: templateId, waves: ["A", "B"] }],
				version: 1,
				...stamp(clock),
			});
			await db.insert(playbook).values({
				id: id(),
				missionType: type,
				name: "Booking",
				wavesApplicable: ["B"],
				gates: [],
				deliverable: "pr",
				requiredFields: [],
				defaultPresetId: presetId,
				version: 1,
				...stamp(clock),
			});
			const missionId = id();
			await db.insert(mission).values({
				id: missionId,
				origin: "client",
				engagementId,
				type,
				brief: PLANNED,
				sprintN: 1,
				status: "draft",
				cut: "horizontal",
				cutSource: "derived",
				repoUrl: "https://github.com/avel-org/app",
				spendCeilingUsd: "25.00",
				...stamp(clock),
			});
			await db.insert(rosterEntry).values({
				id: id(),
				missionId,
				agentTemplateId: templateId,
				active: true,
				waves: ["B"],
				territory: "bookings",
				estimatedTokens: 40000,
				grain: "default",
				absorbedBoundaries: [],
				...stamp(clock),
			});
			const update = {
				name: "Booking, wave A first",
				wavesApplicable: ["A", "B"],
				gates: [],
				deliverable: "pr",
				requiredFields: [],
				defaultPresetId: presetId,
			};
			return { missionId, update };
		}

		const startMission = (missionId: string) =>
			call("starter", `/api/missions/${missionId}/start`, { method: "POST" });
		const updatePlaybook = (type: string, body: unknown) =>
			call("editor", `/api/playbooks/by-type/${type}`, {
				method: "PUT",
				body,
			});
		const reasonOf = async (res: Response) =>
			errorEnvelope.parse(await res.json()).error.details;

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
			starter = gated(db);
			editor = gated(db);
			const appFor = (gate: ReturnType<typeof gated>, prefix: string) =>
				createApp({
					clock,
					ids: prefixedIds(prefix),
					logger,
					auth,
					db: () => gate.db,
					webOrigins: [],
					preview: false,
					repos: noRepos,
					templates: noTemplates,
					dispatchByToken: noDispatches,
					runnerCredentialSha256: null,
					harness: new FakeHarness(),
					prices: DEFAULT_PRICE_BOOK,
					rooms: memoryRooms(),
					roomSources: anySource,
					drive: { blobs: memoryBlobs(), maxBytes: DEFAULT_UPLOAD_MAX_BYTES },
				});
			const apps = {
				starter: appFor(starter, "11111111"),
				editor: appFor(editor, "22222222"),
			};
			const { cookie } = await signInWithGitHub(apps.starter, OPERATOR);
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
			"start first: an update that begins while the start is uncommitted blocks, then gets 422 playbook_in_use",
			async () => {
				const type = "race-start-first";
				const { missionId, update } = await readyMission(type);

				const gate = starter.holdNext();
				const starting = startMission(missionId);
				await gate.reached;

				const updating = updatePlaybook(type, update);
				await someoneWaitsOnALock().catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await starting).status).toBe(200);
				const updated = await updating;
				expect(updated.status).toBe(422);
				expect(await reasonOf(updated)).toMatchObject({
					reason: "playbook_in_use",
				});
			},
			BUDGET_MS,
		);

		it(
			"update first: a start that begins while the update is uncommitted blocks, then checks the new playbook",
			async () => {
				const type = "race-update-first";
				const { missionId, update } = await readyMission(type);

				const gate = editor.holdNext();
				const updating = updatePlaybook(type, update);
				await gate.reached;

				const starting = startMission(missionId);
				await someoneWaitsOnALock().catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await updating).status).toBe(200);
				const started = await starting;
				// The new playbook's first wave is A, which no agent is in.
				expect(started.status).toBe(422);
				expect(await reasonOf(started)).toMatchObject({
					reason: "coherence_blocked",
					wave: "A",
				});
			},
			BUDGET_MS,
		);
	},
);
