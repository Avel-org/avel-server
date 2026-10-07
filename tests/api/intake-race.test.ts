import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import {
	type Brief,
	clientSchema,
	engagementSchema,
	errorEnvelope,
	intakeSchema,
	successEnvelope,
} from "../../src/contract";
import * as schema from "../../src/db/schema";
import { intake, mission } from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import type { Db } from "../../src/db/tx";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";
import { noRepos } from "../unit/repo-fixtures";
import {
	BASE_URL,
	captureLogger,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "../unit/support";

// Intake transitions race each other. Proving the row lock holds takes two
// real, committed transactions on two connections, so this file gets a
// throwaway database of its own, as tests/api/client-race.test.ts does.
// Ordering is driven by conditions, never sleeps.

const url = process.env.DATABASE_URL;
const scratch = `avel_intake_race_${process.pid}`;
const BUDGET_MS = 60_000;

const BRIEF: Brief = {
	summary: "Online booking",
	requirements: [{ id: "R1", text: "A customer books a slot" }],
	acceptanceCriteria: [{ id: "AC1", requirementId: "R1", text: "It shows" }],
};
const APPROVE = {
	missionType: "full-build",
	repoUrl: "https://github.com/meridian-co/app",
};

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
 * and before it commits, it signals `reached` and waits for `release`.
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
	"intake transitions on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		let conn: ReturnType<typeof postgres> | undefined;
		let db: Db;
		let first: ReturnType<typeof gated>;
		let second: ReturnType<typeof gated>;
		let call: (
			app: "first" | "second",
			path: string,
			init?: { method?: string; body?: unknown },
		) => Promise<Response>;

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

		/** Runs `contender` while `holder`'s transaction is held open, then lets both finish. */
		async function race(
			holder: {
				app: "first" | "second";
				path: string;
				method?: string;
				body?: unknown;
			},
			contender: {
				app: "first" | "second";
				path: string;
				method?: string;
				body?: unknown;
			},
		) {
			const gate = (holder.app === "first" ? first : second).holdNext();
			const held = call(holder.app, holder.path, {
				method: holder.method ?? "POST",
				body: holder.body,
			});
			await gate.reached;
			const contending = call(contender.app, contender.path, {
				method: contender.method ?? "POST",
				body: contender.body,
			});
			// Release before failing: a transaction left open past afterAll would
			// orphan the scratch database.
			await someoneWaitsOnALock().catch((e: unknown) => {
				gate.release();
				throw e;
			});
			gate.release();
			return { held: await held, contending: await contending };
		}

		async function newEngagement() {
			const c = await call("first", "/api/clients", {
				method: "POST",
				body: { name: "Meridian" },
			});
			const clientId = successEnvelope(clientSchema).parse(await c.json()).data
				.id;
			const e = await call("first", "/api/engagements", {
				method: "POST",
				body: { clientId, name: "App build" },
			});
			return successEnvelope(engagementSchema).parse(await e.json()).data.id;
		}

		async function newIntake(engagementId: string) {
			const res = await call("first", "/api/intakes", {
				method: "POST",
				body: { engagementId, sourceMd: "Call notes", proposedBrief: BRIEF },
			});
			expect(res.status).toBe(201);
			return successEnvelope(intakeSchema).parse(await res.json()).data.id;
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
			db = drizzle(conn, { schema });

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
			first = gated(db);
			second = gated(db);
			const app = (ids: IdGenerator, g: ReturnType<typeof gated>) =>
				createApp({
					clock,
					ids,
					logger,
					auth,
					db: () => g.db,
					webOrigins: [],
					preview: false,
					repos: noRepos,
				});
			const apps = {
				first: app(prefixedIds("11111111"), first),
				second: app(prefixedIds("22222222"), second),
			};
			const { cookie } = await signInWithGitHub(apps.first, OPERATOR);
			if (!cookie) throw new Error("sign-in failed in the scratch database");
			call = async (which, path, init = {}) =>
				apps[which].request(path, {
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
			"two approvals: the second blocks, then gets 409, and only one Mission exists",
			async () => {
				const engagementId = await newEngagement();
				const id = await newIntake(engagementId);
				await call("first", `/api/intakes/${id}/propose`, { method: "POST" });
				await db
					.update(intake)
					.set({
						derivedCut: "vertical",
						repoUrl: APPROVE.repoUrl,
						repoCommitSha: "c".repeat(40),
						repoReadAt: new Date("2026-10-05T12:00:00.000Z"),
					})
					.where(eq(intake.id, id));

				const path = `/api/intakes/${id}/approve`;
				const { held, contending } = await race(
					{ app: "first", path, body: APPROVE },
					{ app: "second", path, body: APPROVE },
				);
				expect(held.status).toBe(200);
				expect(contending.status, await contending.clone().text()).toBe(409);
				expect(errorEnvelope.parse(await contending.json()).error.code).toBe(
					"CONFLICT",
				);
				const missions = await db
					.select({ id: mission.id })
					.from(mission)
					.where(eq(mission.engagementId, engagementId));
				expect(missions).toHaveLength(1);
			},
			BUDGET_MS,
		);

		it(
			"a propose that starts during a revise checks the revised brief, not the one before it",
			async () => {
				const engagementId = await newEngagement();
				const id = await newIntake(engagementId);

				// The revise drops R1's only criterion, so the revised brief fails rule 4.
				const { held, contending } = await race(
					{
						app: "first",
						path: `/api/intakes/${id}`,
						method: "PATCH",
						body: { proposedBrief: { ...BRIEF, acceptanceCriteria: [] } },
					},
					{ app: "second", path: `/api/intakes/${id}/propose` },
				);
				expect(held.status).toBe(200);
				expect(contending.status, await contending.clone().text()).toBe(422);
				expect(
					errorEnvelope.parse(await contending.json()).error.details,
				).toMatchObject({ reason: "intake_check_failed" });
				const [row] = await db
					.select({ status: intake.status })
					.from(intake)
					.where(eq(intake.id, id));
				expect(row?.status).toBe("draft");
			},
			BUDGET_MS,
		);
	},
);
