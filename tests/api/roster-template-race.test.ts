import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
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
	rosterEntry,
	rosterPreset,
} from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/auth";
import { stamp } from "../../src/db/schema/columns";
import type { Db } from "../../src/db/tx";
import { memoryBlobs } from "../../src/gateways/blob";
import { noRepoWriter } from "../../src/gateways/repo-writer";
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
import { gated, someoneWaitsOnALock } from "./race-support";

// A template edit that gives the template a Firm role races a roster add of
// that template. The edit locks the template FOR UPDATE before it looks for
// roster entries; the add locks it FOR SHARE before it checks the roles. So
// one waits for the other, and the loser sees the winner's commit: the edit
// finds the new entry, or the add finds the Firm role. Applying a preset
// takes the same lock on each of its templates. Proving it takes two
// committed transactions on two connections, so this file gets a throwaway
// database, and orders them by lock waits.

const url = process.env.DATABASE_URL;
const scratch = `avel_roster_race_${process.pid}`;
const BUDGET_MS = 60_000;
const clock = fixedClock("2026-10-21T12:00:00.000Z");

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

function prefixedIds(prefix: string): IdGenerator {
	const inner = sequentialIds();
	return { next: () => inner.next().replace(/^00000000/, prefix) };
}

const BRIEF: Brief = {
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
	"roster add vs template edit, on two committed transactions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		let conn: ReturnType<typeof postgres> | undefined;
		let db: Db;
		let adder: ReturnType<typeof gated>;
		let editor: ReturnType<typeof gated>;
		let call: (
			app: "adder" | "editor",
			path: string,
			init: { method: string; body: unknown },
		) => Promise<Response>;
		const seedIds = prefixedIds("55555555");

		/** A draft mission with an empty roster, and a non-Firm template. */
		async function draftAndTemplate(label: string) {
			const id = () => seedIds.next();
			const clientId = id();
			await db.insert(client).values({
				id: clientId,
				name: `Client ${label}`,
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
			const missionId = id();
			await db.insert(mission).values({
				id: missionId,
				origin: "client",
				engagementId,
				type: "booking",
				brief: BRIEF,
				sprintN: 1,
				status: "draft",
				cut: "vertical",
				cutSource: "derived",
				repoUrl: "https://github.com/avel-org/app",
				spendCeilingUsd: "25.00",
				...stamp(clock),
			});
			const templateId = id();
			await db.insert(agentTemplate).values({
				id: templateId,
				slug: `${label}-kel`,
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
				name: `Preset ${label}`,
				description: null,
				cut: "vertical",
				agents: [{ agent_template_id: templateId, waves: ["B"] }],
				version: 1,
				...stamp(clock),
			});
			return { missionId, templateId, presetId };
		}

		const addToRoster = (missionId: string, templateId: string) =>
			call("adder", `/api/missions/${missionId}/roster`, {
				method: "POST",
				body: { agentTemplateId: templateId },
			});
		const applyPreset = (missionId: string, presetId: string) =>
			call("adder", `/api/missions/${missionId}/roster/apply-preset`, {
				method: "POST",
				body: { presetId },
			});
		const makeFirm = (templateId: string) =>
			call("editor", `/api/agent-templates/${templateId}`, {
				method: "PATCH",
				body: { roles: ["strategy"] },
			});
		const detailsOf = async (res: Response) =>
			errorEnvelope.parse(await res.json()).error.details;
		const state = async (missionId: string, templateId: string) => {
			const entries = await db
				.select({ id: rosterEntry.id })
				.from(rosterEntry)
				.where(eq(rosterEntry.missionId, missionId));
			const [t] = await db
				.select({ roles: agentTemplate.roles, version: agentTemplate.version })
				.from(agentTemplate)
				.where(eq(agentTemplate.id, templateId));
			return { entries: entries.map((e) => e.id), template: t };
		};

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
			adder = gated(db);
			editor = gated(db);
			const appFor = (gate: ReturnType<typeof gated>, prefix: string) =>
				createApp({
					clock,
					ids: prefixedIds(prefix),
					logger,
					auth,
					db: () => gate.db,
					webOrigins: [],
					repos: noRepos,
					repoWriter: noRepoWriter(),
					templates: noTemplates,
					dispatchByToken: noDispatches,
					runnerCredentialSha256: null,
					harness: new FakeHarness(),
					prices: DEFAULT_PRICE_BOOK,
					rooms: memoryRooms(),
					roomSources: anySource,
					drive: { blobs: memoryBlobs(), maxBytes: DEFAULT_UPLOAD_MAX_BYTES },
					checkRunner: null,
					githubWebhookSecret: null,
				});
			const apps = {
				adder: appFor(adder, "11111111"),
				editor: appFor(editor, "22222222"),
			};
			const { cookie } = await signInWithGitHub(apps.adder, OPERATOR);
			if (!cookie) throw new Error("sign-in failed in the scratch database");
			call = async (app, path, init) =>
				apps[app].request(path, {
					method: init.method,
					headers: {
						cookie,
						origin: BASE_URL,
						"content-type": "application/json",
					},
					body: JSON.stringify(init.body),
				});
		}, BUDGET_MS);

		afterAll(async () => {
			await conn?.end();
			await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin?.end();
		}, BUDGET_MS);

		it(
			"add first: an edit to a Firm role that begins while the add is uncommitted blocks, then gets 422 template_not_rosterable",
			async () => {
				const { missionId, templateId } = await draftAndTemplate("add-first");
				const gate = adder.holdNext();
				const adding = addToRoster(missionId, templateId);
				await gate.reached;

				const editing = makeFirm(templateId);
				await someoneWaitsOnALock(
					admin as NonNullable<typeof admin>,
					scratch,
				).catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				const added = await adding;
				expect(added.status).toBe(201);
				const entryId = ((await added.json()) as { data: { id: string } }).data
					.id;
				const edited = await editing;
				expect(edited.status).toBe(422);
				expect(await detailsOf(edited)).toEqual({
					reason: "template_not_rosterable",
					missionId,
					rosterEntryIds: [entryId],
				});
				expect(await state(missionId, templateId)).toEqual({
					entries: [entryId],
					template: { roles: ["domain"], version: 1 },
				});
			},
			BUDGET_MS,
		);

		it(
			"edit first: an add that begins while the edit is uncommitted blocks, then gets 422 template_not_rosterable",
			async () => {
				const { missionId, templateId } = await draftAndTemplate("edit-first");
				const gate = editor.holdNext();
				const editing = makeFirm(templateId);
				await gate.reached;

				const adding = addToRoster(missionId, templateId);
				await someoneWaitsOnALock(
					admin as NonNullable<typeof admin>,
					scratch,
				).catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await editing).status).toBe(200);
				const added = await adding;
				expect(added.status).toBe(422);
				expect(await detailsOf(added)).toEqual({
					reason: "template_not_rosterable",
				});
				expect(await state(missionId, templateId)).toEqual({
					entries: [],
					template: { roles: ["strategy"], version: 2 },
				});
			},
			BUDGET_MS,
		);

		it(
			"edit first: a preset apply that begins while the edit is uncommitted blocks, then gets 422 template_not_rosterable",
			async () => {
				const { missionId, templateId, presetId } =
					await draftAndTemplate("preset-edit-first");
				const gate = editor.holdNext();
				const editing = makeFirm(templateId);
				await gate.reached;

				const applying = applyPreset(missionId, presetId);
				await someoneWaitsOnALock(
					admin as NonNullable<typeof admin>,
					scratch,
				).catch((e: unknown) => {
					gate.release();
					throw e;
				});

				gate.release();
				expect((await editing).status).toBe(200);
				const applied = await applying;
				expect(applied.status).toBe(422);
				expect(await detailsOf(applied)).toEqual({
					reason: "template_not_rosterable",
				});
				expect(await state(missionId, templateId)).toEqual({
					entries: [],
					template: { roles: ["strategy"], version: 2 },
				});
			},
			BUDGET_MS,
		);
	},
);
