import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { logActivity } from "../../src/db/activity";
import type { ClientId } from "../../src/db/client-id";
import {
	canonMessage,
	canonSession,
	canonStep,
	dispatch,
	finding,
	intake,
	mission,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { type CanonScope, withCanonScope } from "../../src/db/tx";
import { memoryBlobs } from "../../src/gateways/blob";
import { randomIds } from "../../src/lib/ids";
import { silentLogger } from "../../src/lib/logger";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import {
	type CanonDeps,
	canonTick,
	FakeCanonModel,
	TEXT_STEP_CHARS,
} from "../../src/runner/canon";
import { type FetchEntity, fetchData } from "../../src/runner/canon/fetch";
import { seedTenants } from "../db/app-role";
import { seedCanonIdentity } from "../db/canon-fixtures";
import { dispatchValues, seedAgent } from "../db/dispatch-fixtures";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

// Fetch mode and the run trace (J, 2026-10-20). Fetch reads operational
// rows: every client's in an open session, one client's in a client session,
// filtered in code because these tables are not under row-level security
// ([attestation]). A turn writes its steps as it runs. Everything as avel_app.

const asApp = { asApp: true };

/** A brief draft_brief would accept, so only the mode can refuse it. */
const BRIEF = {
	summary: "Online booking",
	requirements: [{ id: "R1", text: "A client books a slot" }],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
	],
};

async function setUp(h: ApiHarness) {
	await h.signIn();
	const seeded = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
	await seedCanonIdentity(h.tx, "canon");
	const missionOf = async (engagementId: string | null, type: string) => {
		const id = randomUUID();
		await h.tx.insert(mission).values({
			id,
			origin: engagementId ? "client" : "internal",
			engagementId,
			type,
			brief: {},
			sprintN: 1,
			status: "draft",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			spendCeilingUsd: "25.00",
			...stamp(clock),
		});
		return id;
	};
	const ofA = await missionOf(seeded.a.engagementId, "a-build");
	const ofB = await missionOf(seeded.b.engagementId, "b-build");
	const internal = await missionOf(null, "internal-tooling");

	// One of each operational row for client B, so "A cannot see B" is
	// checked against rows that exist.
	const agent = await seedAgent(h.tx, randomIds, ofB);
	const dispatchB = randomUUID();
	await h.tx.insert(dispatch).values({
		...dispatchValues(agent, randomIds, "queued"),
		id: dispatchB,
		...stamp(clock),
	});
	const findingB = randomUUID();
	await h.tx.insert(finding).values({
		id: findingB,
		missionId: ofB,
		clientId: seeded.b.clientId,
		rule: "tests pass",
		subject: "src/a.ts",
		severity: "high",
		class: "test",
		status: "open",
		caughtBy: "judge",
		...stamp(clock),
	});
	const logged = (
		action: "mission.status_changed" | "mission.gate_run",
		payload: Record<string, unknown>,
	) =>
		logActivity(
			h.tx,
			{ clock, ids: randomIds },
			{
				actorKind: "system",
				action,
				entityType: "mission",
				entityId: ofB,
				missionId: ofB,
				engagementId: seeded.b.engagementId,
				requestId: randomUUID(),
				payload,
			},
		);
	const activityB = (
		await logged("mission.status_changed", { from: "draft", to: "active" })
	).id;
	const gateB = (
		await logged("mission.gate_run", {
			verdict: "pass",
			commitSha: "c".repeat(40),
		})
	).id;
	const ofBRows: Record<FetchEntity, string> = {
		clients: seeded.b.clientId,
		engagements: seeded.b.engagementId,
		intakes: seeded.b.intakeId,
		missions: ofB,
		spend: ofB,
		dispatches: dispatchB,
		activity: activityB,
		gate_runs: gateB,
		findings: findingB,
	};

	const call = async <T = Record<string, unknown>>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	) => {
		const res = await h.call(path, init);
		return { status: res.status, body: (await res.json()) as { data: T } };
	};
	const model = new FakeCanonModel();
	const deps: CanonDeps = {
		db: () => h.tx,
		clock,
		ids: randomIds,
		prices: DEFAULT_PRICE_BOOK,
		blobs: memoryBlobs(),
		model,
		logger: silentLogger(),
	};
	return { ...seeded, ofA, ofB, internal, ofBRows, call, model, deps };
}

const inClient = (clientId: ClientId): CanonScope => ({
	kind: "client",
	clientId,
});
const OPEN: CanonScope = { kind: "open" };

type Table = { type: "table"; rows: Array<Record<string, unknown>> };
const rowsOf = (r: Awaited<ReturnType<typeof fetchData>>) =>
	(r.parts[0] as Table | undefined)?.rows ?? [];

describe.skipIf(!process.env.DATABASE_URL)(
	"Canon fetch and the run trace",
	() => {
		afterAll(closeApi);

		it("reads every client's missions in an open session, and only its own in a client's", async () => {
			await withApi(async (h) => {
				const s = await setUp(h);
				const ids = (r: Awaited<ReturnType<typeof fetchData>>) =>
					rowsOf(r).map((x) => x.id);
				const open = await fetchData(h.tx, OPEN, {
					entity: "missions",
					limit: 50,
				});
				expect(ids(open)).toEqual(
					expect.arrayContaining([s.ofA, s.ofB, s.internal]),
				);

				const mine = await fetchData(h.tx, inClient(s.a.scope), {
					entity: "missions",
					limit: 50,
				});
				expect(ids(mine)).toEqual([s.ofA]);
				// Another client's mission by id is not there; asking for another
				// client by name is the tool's error, never an empty answer.
				const theirs = await fetchData(h.tx, inClient(s.a.scope), {
					entity: "missions",
					id: s.ofB,
				});
				expect(ids(theirs)).toEqual([]);
				const other = await fetchData(h.tx, inClient(s.a.scope), {
					entity: "missions",
					clientId: s.b.clientId,
				});
				expect(other).toMatchObject({ isError: true, parts: [] });

				// Every entity holds the same line, against a row of B's that the
				// open scope proves is there.
				for (const [entity, rowOfB] of Object.entries(s.ofBRows)) {
					const input = { entity, limit: 50 };
					const seen = JSON.stringify(await fetchData(h.tx, OPEN, input));
					expect(seen, `open ${entity}`).toContain(rowOfB);
					const fromA = JSON.stringify(
						await fetchData(h.tx, inClient(s.a.scope), input),
					);
					expect(fromA, `A's ${entity}`).not.toContain(rowOfB);
					expect(fromA, `A's ${entity}`).not.toContain(s.b.clientId);
				}
			}, asApp);
		});

		it("reads no client's words: no notes, intake source or brief", async () => {
			await withApi(async (h) => {
				const s = await setUp(h);
				const keys = async (entity: "clients" | "intakes" | "missions") =>
					Object.keys(rowsOf(await fetchData(h.tx, OPEN, { entity }))[0] ?? {});
				expect(await keys("clients")).toEqual(["id", "name", "status"]);
				for (const k of ["sourceMd", "proposedBrief", "openQuestions"]) {
					expect(await keys("intakes")).not.toContain(k);
				}
				expect(await keys("intakes")).toContain("status");
				expect(await keys("missions")).not.toContain("brief");
				// One row by id is a card.
				const card = await fetchData(h.tx, OPEN, {
					entity: "missions",
					id: s.ofA,
				});
				expect(card.parts).toEqual([
					expect.objectContaining({
						type: "entity",
						entityType: "mission",
						id: s.ofA,
					}),
				]);
				// A malformed input is the tool's error.
				expect(
					(await fetchData(h.tx, OPEN, { entity: "connections" })).isError,
				).toBe(true);
			}, asApp);
		});

		it("runs a fetch turn: steps as it goes, and the table beside the reply", async () => {
			await withApi(async (h) => {
				const s = await setUp(h);
				const session = (
					await s.call<{ id: string }>("/api/canon-sessions", {
						method: "POST",
						// On an intake, so the draft tools exist and only the mode
						// keeps them from running.
						body: {
							scope: "client",
							clientId: s.a.clientId,
							intakeId: s.a.intakeId,
							mode: "fetch",
						},
					})
				).body.data;
				await s.call(`/api/canon-sessions/${session.id}/messages`, {
					method: "POST",
					body: { contentMd: "What is running?" },
				});
				s.model.script(session.id, [
					{ reasoning: "The operator wants missions." },
					{ text: "Let me " },
					{ text: "look." },
					{ tool: "fetch", input: { entity: "missions" } },
					{ tool: "draft_brief", input: { brief: BRIEF } },
					{ text: "x".repeat(TEXT_STEP_CHARS) },
					{ reply: "One mission, a draft." },
				]);
				expect((await canonTick(s.deps)).map((r) => r.outcome)).toEqual([
					"replied",
				]);
				const steps = await withCanonScope(h.tx, inClient(s.a.scope), (tx) =>
					tx
						.select()
						.from(canonStep)
						.where(eq(canonStep.canonSessionId, session.id))
						.orderBy(asc(canonStep.seq)),
				);
				expect(steps.map((x) => [x.seq, x.turn, x.kind])).toEqual([
					[1, 1, "reasoning_summary"],
					[2, 1, "text"],
					[3, 1, "tool_call"],
					[4, 1, "tool_result"],
					[5, 1, "tool_call"],
					[6, 1, "tool_result"],
					[7, 1, "text"],
				]);
				expect(steps[1]?.detail).toEqual({ text: "Let me look." });
				expect(steps[3]?.detail).toMatchObject({ callSeq: 3, isError: false });
				// draft_brief is not a fetch tool: refused, and recorded as refused.
				expect(steps[5]?.detail).toMatchObject({ callSeq: 5, isError: true });
				expect(steps.every((x) => x.clientId === s.a.clientId)).toBe(true);
				const [untouched] = await h.tx
					.select({
						brief: intake.proposedBrief,
						by: intake.draftedByCanonSessionId,
					})
					.from(intake)
					.where(eq(intake.id, s.a.intakeId));
				expect(untouched).toEqual({ brief: null, by: null });

				const messages = await withCanonScope(h.tx, inClient(s.a.scope), (tx) =>
					tx
						.select()
						.from(canonMessage)
						.where(eq(canonMessage.canonSessionId, session.id))
						.orderBy(asc(canonMessage.seq)),
				);
				const reply = messages[1];
				expect(reply).toMatchObject({ role: "canon", mode: "fetch" });
				expect(reply?.parts).toEqual([
					expect.objectContaining({
						type: "table",
						rows: [expect.objectContaining({ id: s.ofA })],
					}),
				]);
				// And the wire carries them.
				const wire = await s.call<Array<{ parts: unknown[] }>>(
					`/api/canon-sessions/${session.id}/messages`,
				);
				expect(wire.body.data[1]?.parts).toHaveLength(1);
			}, asApp);
		});

		it("names an untitled session once, and never one the operator named", async () => {
			await withApi(async (h) => {
				const s = await setUp(h);
				const open = async (title?: string) => {
					const id = (
						await s.call<{ id: string }>("/api/canon-sessions", {
							method: "POST",
							body: { scope: "open" },
						})
					).body.data.id;
					if (title) {
						await s.call(`/api/canon-sessions/${id}`, {
							method: "PATCH",
							body: { title },
						});
					}
					await s.call(`/api/canon-sessions/${id}/messages`, {
						method: "POST",
						body: { contentMd: "Hello" },
					});
					s.model.script(id, [
						{ tool: "name_session", input: { title: "Canon's name" } },
						{ reply: "Hi." },
					]);
					return id;
				};
				const untitled = await open();
				const named = await open("Mine");
				await canonTick(s.deps);
				const titles = await withCanonScope(h.tx, OPEN, (tx) =>
					tx
						.select({
							id: canonSession.id,
							title: canonSession.title,
							by: canonSession.titleSetBy,
						})
						.from(canonSession),
				);
				const byId = new Map(titles.map((t) => [t.id, t]));
				expect(byId.get(untitled)).toMatchObject({
					title: "Canon's name",
					by: "canon",
				});
				expect(byId.get(named)).toMatchObject({
					title: "Mine",
					by: "operator",
				});
			}, asApp);
		});

		it("writes an error step when the turn fails, in an open session", async () => {
			await withApi(async (h) => {
				const s = await setUp(h);
				const id = (
					await s.call<{ id: string }>("/api/canon-sessions", {
						method: "POST",
						body: { scope: "open" },
					})
				).body.data.id;
				await s.call(`/api/canon-sessions/${id}/messages`, {
					method: "POST",
					body: { contentMd: "Hello" },
				});
				s.model.script(id, [{ fail: "the model went away" }]);
				expect((await canonTick(s.deps)).map((r) => r.outcome)).toEqual([
					"failed",
				]);
				const steps = await withCanonScope(h.tx, OPEN, (tx) =>
					tx.select().from(canonStep).where(eq(canonStep.canonSessionId, id)),
				);
				expect(steps).toMatchObject([
					{
						kind: "error",
						clientId: null,
						detail: { message: "the model went away" },
					},
				]);
			}, asApp);
		});
	},
);
