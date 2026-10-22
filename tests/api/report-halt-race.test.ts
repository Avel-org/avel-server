import path from "node:path";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { signInRecorder } from "../../src/auth/sign-in-activity";
import { errorEnvelope } from "../../src/contract";
import { dispatchByTokenSha256 } from "../../src/db/dispatch";
import * as schema from "../../src/db/schema";
import {
	agentIdentityVersion,
	agentTemplate,
	completionReport,
	dispatch,
	mission,
	rosterEntry,
} from "../../src/db/schema";
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
import { DISPATCH_PLAN, dispatchValues, sha } from "../db/dispatch-fixtures";
import { makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { noRepos } from "../unit/repo-fixtures";
import {
	BASE_URL,
	captureLogger,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "../unit/support";
import { gated, someoneWaitsOnALock } from "./race-support";

// An operator halt races the agent's own report. Both lock the mission,
// then the dispatch, so one waits for the other; the loser finds the
// dispatch no longer running and is refused dispatch_not_running. Proving
// it takes two committed transactions on two connections, so this file
// gets a throwaway database, and orders them by lock waits.

const url = process.env.DATABASE_URL;
const scratch = `avel_report_race_${process.pid}`;
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

const report = {
	status: "complete",
	artifactsRead: [],
	blockers: [],
	rereads: 0,
} as const;

describe.skipIf(!url)(
	"operator halt vs the agent's report, on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		const files = tempDir("report-race");
		const sources = path.join(files, "sources");
		const [commit] = makeRepo(
			path.join(sources, "templates", "template-booking"),
			{ "src/a.ts": "export const a = 1;\n" },
		) as [string];
		const harness = new FakeHarness();
		let conn: ReturnType<typeof postgres> | undefined;
		let db: Db;
		let halter: ReturnType<typeof gated>;
		let reporter: ReturnType<typeof gated>;
		let operatorCall: (path: string, method?: string) => Promise<Response>;
		let agentCall: (token: string, body: unknown) => Promise<Response>;
		const seedIds = prefixedIds("44444444");

		/** A running dispatch, started through the route; its token from the harness. */
		async function runningDispatch(label: string) {
			const id = () => seedIds.next();
			// An internal template build: its rooms come from the template clone.
			const missionId = id();
			await db.insert(mission).values({
				id: missionId,
				engagementId: null,
				origin: "internal",
				type: "template-booking",
				brief: DISPATCH_PLAN,
				sprintN: 1,
				status: "active",
				cut: "vertical",
				cutSource: "derived",
				repoUrl: "https://github.com/avel-org/template-booking",
				spendCeilingUsd: "100.00",
				templateRef: "template-booking",
				templateVersion: commit,
				...stamp(clock),
			});
			const templateId = id();
			const slug = `kel-${label}`;
			await db.insert(agentTemplate).values({
				id: templateId,
				slug,
				name: "Kel",
				title: "Backend builder",
				kind: "horizontal",
				roles: ["domain", "api-surface"],
				waveDefaults: ["B"],
				writablePaths: ["src/**"],
				version: 1,
				...stamp(clock),
			});
			const versionId = id();
			await db.insert(agentIdentityVersion).values({
				id: versionId,
				agentTemplateId: templateId,
				number: 1,
				identityMd: `# ${slug}\n`,
				depthMd: "",
				sha256: sha("d"),
				identityTokens: 1,
				depthTokens: 0,
				inputs: {
					generatorVersion: "identity-v1",
					slug,
					name: "Kel",
					kind: "horizontal",
					roles: ["domain", "api-surface"],
					writablePaths: ["src/**"],
					definitionsSha256: sha("e"),
					skills: [],
				},
				generatedBy: null,
				createdAt: clock.now(),
			});
			const entryId = id();
			await db.insert(rosterEntry).values({
				id: entryId,
				missionId,
				agentTemplateId: templateId,
				active: true,
				waves: ["B"],
				territory: "accounts",
				grain: "default",
				absorbedBoundaries: [],
				...stamp(clock),
			});
			const dispatchId = id();
			await db.insert(dispatch).values({
				id: dispatchId,
				...dispatchValues(
					{
						missionId,
						templateId,
						entryId,
						versionId,
						versionSha: sha("d"),
						slug,
					},
					seedIds,
					"queued",
				),
				...stamp(clock),
			});
			const started = await operatorCall(`/api/dispatches/${dispatchId}/start`);
			expect(started.status).toBe(200);
			const token = harness.tokenFor(dispatchId);
			if (!token) throw new Error("no session");
			return { dispatchId, token };
		}

		const state = async (dispatchId: string) => {
			const [d] = await db
				.select({ status: dispatch.status, halt: dispatch.haltReason })
				.from(dispatch)
				.where(eq(dispatch.id, dispatchId));
			const reports = await db
				.select({
					status: completionReport.status,
					by: completionReport.filedBy,
				})
				.from(completionReport)
				.where(eq(completionReport.dispatchId, dispatchId));
			return { d, reports };
		};

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
			halter = gated(db);
			reporter = gated(db);
			const rooms = worktreeRooms(path.join(files, "rooms"));
			const roomSources = localSources(sources);
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
					dispatchByToken: dispatchByTokenSha256,
					runnerCredentialSha256: null,
					harness,
					prices: DEFAULT_PRICE_BOOK,
					rooms,
					roomSources,
					drive: { blobs: memoryBlobs(), maxBytes: DEFAULT_UPLOAD_MAX_BYTES },
				});
			const operatorApp = appFor(halter, "11111111");
			const agentApp = appFor(reporter, "22222222");
			const { cookie } = await signInWithGitHub(operatorApp, OPERATOR);
			if (!cookie) throw new Error("sign-in failed in the scratch database");
			operatorCall = async (p, method = "POST") =>
				operatorApp.request(p, {
					method,
					headers: { cookie, origin: BASE_URL },
				});
			agentCall = async (token, body) =>
				agentApp.request("/api/agent/report", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				});
		}, BUDGET_MS);

		afterAll(async () => {
			await conn?.end();
			await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin?.end();
			removeDir(files);
		}, BUDGET_MS);

		it(
			"report first: a halt that begins while the report is uncommitted blocks, then gets 422 dispatch_not_running",
			async () => {
				const run = await runningDispatch("report-first");
				const gate = reporter.holdNext();
				const reporting = agentCall(run.token, report);
				await gate.reached;

				const halting = operatorCall(`/api/dispatches/${run.dispatchId}/halt`);
				await someoneWaitsOnALock(
					admin as NonNullable<typeof admin>,
					scratch,
				).catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await reporting).status).toBe(201);
				const halted = await halting;
				expect(halted.status).toBe(422);
				expect(await reasonOf(halted)).toMatchObject({
					reason: "dispatch_not_running",
				});
				expect(await state(run.dispatchId)).toEqual({
					d: { status: "complete", halt: null },
					reports: [{ status: "complete", by: "agent" }],
				});
			},
			BUDGET_MS,
		);

		it(
			"halt first: a report that begins while the halt is uncommitted blocks, then gets 422 dispatch_not_running",
			async () => {
				const run = await runningDispatch("halt-first");
				const gate = halter.holdNext();
				const halting = operatorCall(`/api/dispatches/${run.dispatchId}/halt`);
				await gate.reached;

				// The token still reads as running outside the lock; the report
				// then waits for the halt's mission lock.
				const reporting = agentCall(run.token, report);
				await someoneWaitsOnALock(
					admin as NonNullable<typeof admin>,
					scratch,
				).catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await halting).status).toBe(200);
				const reported = await reporting;
				expect(reported.status).toBe(422);
				expect(await reasonOf(reported)).toMatchObject({
					reason: "dispatch_not_running",
				});
				expect(await state(run.dispatchId)).toEqual({
					d: { status: "halted", halt: "operator" },
					reports: [{ status: "halted", by: "system" }],
				});
			},
			BUDGET_MS,
		);
	},
);
