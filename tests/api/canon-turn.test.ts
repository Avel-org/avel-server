import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepStuckCanonTurns } from "../../src/db/canon";
import { closeDb } from "../../src/db/client";
import type { ClientId } from "../../src/db/client-id";
import {
	activityLog,
	agentTemplate,
	canonMessage,
	canonQuestion,
	canonSession,
	clientMemory,
	file,
	intake,
	intakeFiles,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import {
	type CanonScope,
	type Tx,
	withClientScope,
	withTx,
} from "../../src/db/tx";
import { blobPrefix, memoryBlobs } from "../../src/gateways/blob";
import { sourceFor, splitKnowledge } from "../../src/lib/canon";
import { randomIds } from "../../src/lib/ids";
import { silentLogger } from "../../src/lib/logger";
import { PRICE_VERSION } from "../../src/lib/prices";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import {
	type CanonDeps,
	canonTick,
	FAKE_CANON_VERSION,
	FakeCanonModel,
	NO_MODEL_REPLY,
	offlineCanonModel,
	runCanonTurn,
} from "../../src/runner/canon";
import { canonTools } from "../../src/runner/canon/tools";
import { connectAsApp, one, seedTenants } from "../db/app-role";
import {
	seedCanonIdentity,
	sessionValues,
	type Tenant,
} from "../db/canon-fixtures";
import { clock, inRollback } from "../db/fixtures";

// Whole Canon turns, played by the FakeCanonModel, as avel_app so row-level
// security applies. No real model is ever called here.

const DOCS = {
	Meridian:
		"# Booking\nClients book a slot.\n## Payments\nCards through Stripe.",
	Halcyon: "# Halcyon secret plan\nHalcyon's private roadmap.",
};
const MEMORY = {
	Meridian: "Meridian salons open at nine.",
	Halcyon: "Halcyon secret memory.",
};

const inClient = (clientId: ClientId): CanonScope => ({
	kind: "client",
	clientId,
});

describe.skipIf(!process.env.DATABASE_URL)("a Canon turn", () => {
	let app: ReturnType<typeof connectAsApp>;
	beforeAll(() => {
		app = connectAsApp();
	});
	afterAll(async () => {
		await app.end();
		await closeDb();
	});

	class Rollback extends Error {}
	async function asApp(fn: (tx: Tx) => Promise<void>) {
		await withTx(app.db, async (tx) => {
			await fn(tx);
			throw new Rollback();
		}).catch((e: unknown) => {
			if (!(e instanceof Rollback)) throw e;
		});
	}

	/** Two clients, each with a Markdown file on its intake, kept memory and an open session mid-turn. */
	async function seed(tx: Tx) {
		const { userId, a, b } = await seedTenants(tx, ["Meridian", "Halcyon"]);
		const identity = await seedCanonIdentity(tx);
		const blobs = memoryBlobs();
		const out: Record<
			"a" | "b",
			Tenant & {
				sessionId: string;
				fileId: string;
				sha256: string;
				text: string;
			}
		> = {} as never;
		for (const [key, t, name] of [
			["a", a, "Meridian"],
			["b", b, "Halcyon"],
		] as const) {
			const text = DOCS[name];
			const put = await blobs.put(
				blobPrefix(t.clientId),
				new TextEncoder().encode(text),
			);
			const fileId = randomUUID();
			const session = sessionValues(t, userId, identity, {
				turnStartedAt: clock.now(),
				priceVersion: PRICE_VERSION,
				harnessVersion: FAKE_CANON_VERSION,
			});
			await withClientScope(tx, t.scope, async (s) => {
				await s.insert(file).values({
					id: fileId,
					scope: "engagement",
					clientId: t.clientId,
					engagementId: t.engagementId,
					name: `${name}.md`,
					mime: "text/markdown",
					bytes: text.length,
					sha256: put.sha256,
					storageKey: put.key,
					uploadedBy: userId,
					purgedAt: null,
					...stamp(clock),
				});
				await s.insert(intakeFiles).values({ intakeId: t.intakeId, fileId });
				await s.insert(canonSession).values(session);
				await s.insert(canonMessage).values({
					id: randomUUID(),
					canonSessionId: session.id as string,
					clientId: t.clientId,
					seq: 1,
					role: "operator",
					mode: "draft",
					parts: [],
					contentMd: `Brief ${name}, please.`,
					citations: [],
					createdAt: clock.now(),
				});
				await s.insert(clientMemory).values({
					id: randomUUID(),
					clientId: t.clientId,
					contentMd: MEMORY[name],
					status: "kept",
					...stamp(clock),
				});
			});
			out[key] = {
				...t,
				sessionId: session.id as string,
				fileId,
				sha256: put.sha256,
				text,
			};
		}
		const model = new FakeCanonModel();
		const sweeps: number[] = [];
		const deps: CanonDeps = {
			db: () => tx,
			clock,
			ids: randomIds,
			prices: DEFAULT_PRICE_BOOK,
			blobs,
			model,
			logger: silentLogger(),
			sweepStuckTurns: async (_db, _clock, maxMs) => {
				sweeps.push(maxMs);
			},
		};
		const chunksOf = (t: (typeof out)["a"]) =>
			splitKnowledge([
				{ fileId: t.fileId, sha256: t.sha256, name: "x", contentMd: t.text },
			]);
		return { userId, identity, ...out, deps, model, sweeps, chunksOf };
	}

	const sessionRow = (tx: Tx, t: Tenant & { sessionId: string }) =>
		withClientScope(tx, t.scope, async (s) =>
			one(
				await s
					.select()
					.from(canonSession)
					.where(eq(canonSession.id, t.sessionId)),
			),
		);

	const messagesOf = (tx: Tx, t: Tenant & { sessionId: string }) =>
		withClientScope(tx, t.scope, (s) =>
			s
				.select()
				.from(canonMessage)
				.where(eq(canonMessage.canonSessionId, t.sessionId))
				.orderBy(canonMessage.seq),
		);

	/**
	 * The operator posts again: a new operator message at `seq` and the turn
	 * started. A turn runs once (its claim), so a test that runs a session
	 * again starts a new turn, as the route does.
	 */
	const postAgain = (tx: Tx, t: Tenant & { sessionId: string }, seq: number) =>
		withClientScope(tx, t.scope, async (x) => {
			await x.insert(canonMessage).values({
				id: randomUUID(),
				canonSessionId: t.sessionId,
				clientId: t.clientId,
				seq,
				role: "operator",
				mode: "draft",
				parts: [],
				contentMd: `Again, ${seq}.`,
				citations: [],
				createdAt: clock.now(),
			});
			await x
				.update(canonSession)
				.set({ turnStartedAt: clock.now() })
				.where(eq(canonSession.id, t.sessionId));
		});

	const activityOf = (tx: Tx, sessionId: string) =>
		tx
			.select()
			.from(activityLog)
			.where(
				or(
					eq(activityLog.actorCanonSessionId, sessionId),
					eq(activityLog.entityId, sessionId),
				),
			)
			.orderBy(activityLog.at, activityLog.id);

	const question = (sourceChunkIds: string[] = []) => ({
		header: "Payments",
		question: "Stripe or Square for checkout?",
		options: [
			{ label: "Stripe", description: "The brief names it" },
			{ label: "Square", description: "Matches the terminal" },
		],
		multiSelect: false,
		reason: "The brief and the call notes disagree.",
		sourceChunkIds,
	});

	const brief = {
		summary: "Online booking for Meridian's salons",
		requirements: [{ id: "R1", text: "A client books a slot" }],
		acceptanceCriteria: [
			{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
		],
	};

	it("asks the operator, then ends the turn with no reply", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const [chunk] = s.chunksOf(s.a);
			if (!chunk) throw new Error("no chunk");
			s.model.script(s.a.sessionId, [
				{
					usage: {
						tokensIn: 100,
						tokensOut: 20,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
				{ tool: "ask_operator", input: question([chunk.chunkId]) },
			]);
			const result = await runCanonTurn(
				s.deps,
				inClient(s.a.scope),
				s.a.sessionId,
			);
			expect(result.outcome).toBe("ended");
			expect(result.promptSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(s.model.toolCalls[0]?.result.isError).toBeFalsy();

			const [q] = await withClientScope(tx, s.a.scope, (x) =>
				x
					.select()
					.from(canonQuestion)
					.where(eq(canonQuestion.canonSessionId, s.a.sessionId)),
			);
			expect(q).toMatchObject({
				intakeId: s.a.intakeId,
				clientId: s.a.clientId,
				header: "Payments",
				status: "open",
				sourceChunkIds: [chunk.chunkId],
			});
			const session = await sessionRow(tx, s.a);
			expect(session).toMatchObject({
				status: "open",
				turnStartedAt: null,
				tokensUsed: 120,
			});
			expect(await messagesOf(tx, s.a)).toHaveLength(1);
			const asked = (await activityOf(tx, s.a.sessionId)).filter(
				(r) => r.action === "canon_question.asked",
			);
			expect(asked).toEqual([
				expect.objectContaining({
					actorKind: "canon",
					actorCanonSessionId: s.a.sessionId,
					entityType: "canon_question",
					entityId: q?.id,
				}),
			]);
		});
	});

	it("drafts the brief, then replies with citations mapped to chunks", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			await tx
				.update(intake)
				.set({ derivedCutEvidence: "from the repository" })
				.where(eq(intake.id, s.a.intakeId));
			const [booking] = s.chunksOf(s.a);
			if (!booking) throw new Error("no chunk");
			s.model.script(s.a.sessionId, [
				{ tool: "draft_brief", input: { brief } },
				{
					tool: "draft_brief",
					input: { brief: { ...brief, acceptanceCriteria: [] } },
				},
				{
					reply: "Clients book a slot, so R1 covers booking.",
					citations: [{ source: sourceFor(booking), cited_text: booking.text }],
				},
			]);
			const result = await runCanonTurn(
				s.deps,
				inClient(s.a.scope),
				s.a.sessionId,
			);
			expect(result.outcome).toBe("replied");
			const [first, second] = s.model.toolCalls;
			expect(first?.result).toMatchObject({
				text: expect.stringContaining("no issues"),
			});
			expect(second?.result.text).toContain("R1 has no acceptance criterion");

			const row = one(
				await tx.select().from(intake).where(eq(intake.id, s.a.intakeId)),
			);
			expect(row.proposedBrief).toEqual({ ...brief, acceptanceCriteria: [] });
			expect(row.draftedByCanonSessionId).toBe(s.a.sessionId);
			expect(row.derivedCutEvidence).toBe("from the repository");
			expect(row.derivedCut).toBeNull();

			const messages = await messagesOf(tx, s.a);
			expect(messages.map((m) => [m.seq, m.role])).toEqual([
				[1, "operator"],
				[2, "canon"],
			]);
			expect(messages[1]).toMatchObject({
				contentMd: "Clients book a slot, so R1 covers booking.",
				citations: [
					{
						chunkId: booking.chunkId,
						heading: ["Booking"],
						quote: booking.text,
					},
				],
			});
			expect((await sessionRow(tx, s.a)).turnStartedAt).toBeNull();
			const drafted = (await activityOf(tx, s.a.sessionId)).filter(
				(r) => r.action === "intake.drafted_by_canon",
			);
			expect(
				drafted.map((r) => [r.actorKind, r.entityType, r.entityId]),
			).toEqual([
				["canon", "intake", s.a.intakeId],
				["canon", "intake", s.a.intakeId],
			]);
		});
	});

	it("stores a draft's sources as chunk ids, and refuses a passage it was not shown", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const [booking] = s.chunksOf(s.a);
			const [other] = s.chunksOf(s.b);
			if (!booking || !other) throw new Error("no chunk");
			const cited = {
				...brief,
				// Canon copies a search result's source; a bare chunk id also works.
				requirements: [
					{ ...brief.requirements[0], sources: [sourceFor(booking)] },
				],
				acceptanceCriteria: [
					{ ...brief.acceptanceCriteria[0], sources: [booking.chunkId] },
				],
			};
			s.model.script(s.a.sessionId, [
				{ tool: "draft_brief", input: { brief: cited } },
				{
					tool: "draft_brief",
					input: {
						brief: {
							...cited,
							// Another client's passage: never shown to this turn.
							requirements: [
								{ ...brief.requirements[0], sources: [other.chunkId] },
							],
						},
					},
				},
				{ reply: "R1: a client books a slot.", citations: [] },
			]);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			const [first, second] = s.model.toolCalls;
			expect(first?.result.isError ?? false).toBe(false);
			expect(second?.result).toMatchObject({
				isError: true,
				text: expect.stringContaining("Cite only the passages you were given"),
			});
			const row = one(
				await tx.select().from(intake).where(eq(intake.id, s.a.intakeId)),
			);
			expect(row.proposedBrief).toMatchObject({
				requirements: [{ id: "R1", sources: [booking.chunkId] }],
				acceptanceCriteria: [{ id: "AC1", sources: [booking.chunkId] }],
			});
		});
	});

	it("refuses a draft with modules, or once the intake is no longer a draft", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			s.model.script(s.a.sessionId, [
				{
					tool: "draft_brief",
					input: {
						brief: {
							...brief,
							modules: [
								{
									id: "M1",
									name: "Booking",
									requirementIds: ["R1"],
									reads: [],
								},
							],
						},
					},
				},
			]);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			expect(s.model.toolCalls[0]?.result).toMatchObject({ isError: true });

			await tx
				.update(intake)
				.set({ status: "proposed" })
				.where(eq(intake.id, s.a.intakeId));
			await postAgain(tx, s.a, 2);
			s.model.script(s.a.sessionId, [
				{ tool: "draft_brief", input: { brief } },
			]);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			expect(s.model.toolCalls[1]?.result).toMatchObject({ isError: true });
			const row = one(
				await tx.select().from(intake).where(eq(intake.id, s.a.intakeId)),
			);
			expect(row.proposedBrief).toBeNull();
			expect(row.draftedByCanonSessionId).toBeNull();
		});
	});

	it("proposes memory and recommends a roster through its tools", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const [template] = await tx
				.select({ id: agentTemplate.id })
				.from(agentTemplate)
				.where(eq(agentTemplate.name, "Canon"));
			if (!template) throw new Error("no template");
			const agent = {
				agentTemplateId: template.id,
				waves: ["A"],
				territory: null,
				writablePaths: null,
				estimatedTokens: null,
				reason: "It knows booking.",
			};
			s.model.script(s.a.sessionId, [
				{
					tool: "propose_memory",
					input: { contentMd: "Meridian uses Stripe." },
				},
				{ tool: "recommend_roster", input: { agents: [agent] } },
				{ tool: "recommend_roster", input: { agents: [agent, agent] } },
				{
					tool: "recommend_roster",
					input: { agents: [{ ...agent, agentTemplateId: randomUUID() }] },
				},
			]);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			expect(s.model.toolCalls.map((c) => Boolean(c.result.isError))).toEqual([
				false,
				false,
				true,
				true,
			]);
			const memory = await withClientScope(tx, s.a.scope, (x) =>
				x
					.select()
					.from(clientMemory)
					.where(eq(clientMemory.proposedByCanonSessionId, s.a.sessionId)),
			);
			expect(memory).toEqual([
				expect.objectContaining({
					contentMd: "Meridian uses Stripe.",
					status: "proposed",
				}),
			]);
			const row = one(
				await tx.select().from(intake).where(eq(intake.id, s.a.intakeId)),
			);
			expect(row.recommendedRoster).toEqual({ agents: [agent] });
			const proposed = (await activityOf(tx, s.a.sessionId)).filter(
				(r) => r.action === "client_memory.proposed",
			);
			expect(proposed.map((r) => [r.actorKind, r.entityId])).toEqual([
				["canon", memory[0]?.id],
			]);
			// Only the recommendation that was written logs; the refused ones write nothing.
			const updated = (await activityOf(tx, s.a.sessionId)).filter(
				(r) => r.action === "intake.updated",
			);
			expect(
				updated.map((r) => [r.actorKind, r.entityType, r.entityId, r.payload]),
			).toEqual([
				[
					"canon",
					"intake",
					s.a.intakeId,
					{
						canonSessionId: s.a.sessionId,
						field: "recommendedRoster",
						agentCount: 1,
					},
				],
			]);
		});
	});

	it("fails the turn on a citation that names no chunk or quotes nothing in it", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const [booking] = s.chunksOf(s.a);
			if (!booking) throw new Error("no chunk");
			for (const [i, citation] of [
				{ source: "canon://nowhere/x", cited_text: booking.text },
				{ source: sourceFor(booking), cited_text: "Clients book a table." },
			].entries()) {
				// The seed's message is the first turn; each later one is posted.
				if (i > 0) await postAgain(tx, s.a, i + 1);
				s.model.script(s.a.sessionId, [
					{ reply: "Booking.", citations: [citation] },
				]);
				expect(
					(await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId))
						.outcome,
				).toBe("failed");
				expect(
					(await messagesOf(tx, s.a)).filter((m) => m.role === "canon"),
				).toEqual([]);
				expect((await sessionRow(tx, s.a)).turnStartedAt).toBeNull();
			}
		});
	});

	it("halts the session at its hard ceiling, priced at its frozen version, and clears the turn", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			s.model.script(s.a.sessionId, [
				{
					usage: {
						tokensIn: 2000,
						tokensOut: 1000,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
				{ tool: "propose_memory", input: { contentMd: "Never written." } },
				{ reply: "Never stored." },
			]);
			expect(
				(await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId))
					.outcome,
			).toBe("halted");
			const session = await sessionRow(tx, s.a);
			expect(session).toMatchObject({
				status: "halted",
				haltReason: "token_hard_ceiling",
				turnStartedAt: null,
				closedAt: clock.now(),
				tokensUsed: 3000,
			});
			expect(Number(session.spendUsd)).toBeGreaterThan(0);
			expect(s.model.toolCalls).toEqual([]);
			expect(await messagesOf(tx, s.a)).toHaveLength(1);
			const halted = (await activityOf(tx, s.a.sessionId)).filter(
				(r) => r.action === "canon_session.halted",
			);
			expect(halted.map((r) => [r.actorKind, r.payload])).toEqual([
				[
					"system",
					{
						haltReason: "token_hard_ceiling",
						tokensUsed: 3000,
						tokenHardCeiling: 3000,
					},
				],
			]);
		});
	});

	it("answers with no model connected, so the turn ends and the operator can post again", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const deps = { ...s.deps, model: offlineCanonModel() };
			const results = await canonTick(deps);
			expect(results.map((r) => r.outcome)).toEqual(["replied", "replied"]);
			for (const t of [s.a, s.b]) {
				expect(await sessionRow(tx, t)).toMatchObject({
					status: "open",
					turnStartedAt: null,
				});
				const messages = await messagesOf(tx, t);
				expect(messages.at(-1)).toMatchObject({
					role: "canon",
					contentMd: NO_MODEL_REPLY,
					citations: [],
				});
			}
			// Nothing is left mid-turn for the next tick.
			expect(await canonTick(deps)).toEqual([]);
		});
	});

	it("clears the turn when the model fails, and leaves the session open", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			s.model.script(s.a.sessionId, [{ fail: "the model went away" }]);
			expect(
				(await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId))
					.outcome,
			).toBe("failed");
			expect(await sessionRow(tx, s.a)).toMatchObject({
				status: "open",
				turnStartedAt: null,
			});
		});
	});

	it("reads only its own client: files, memory, chunks and session", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const [theirs] = s.chunksOf(s.b);
			if (!theirs) throw new Error("no chunk");
			s.model.script(s.a.sessionId, [
				{ tool: "ask_operator", input: question([theirs.chunkId]) },
			]);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			const prompt = JSON.stringify(s.model.prompts[0]);
			expect(prompt).toContain("Clients book a slot.");
			expect(prompt).toContain(MEMORY.Meridian);
			expect(prompt).not.toContain("Halcyon");
			expect(s.model.toolCalls[0]?.result).toMatchObject({ isError: true });

			// Another client's scope cannot see the session at all.
			s.model.script(s.a.sessionId, [{ reply: "Leaked." }]);
			expect(
				(await runCanonTurn(s.deps, inClient(s.b.scope), s.a.sessionId))
					.outcome,
			).toBe("skipped");
			expect(s.model.prompts).toHaveLength(1);
		});
	});

	it("writes ids, statuses and counts to the activity log, never client text", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const [booking] = s.chunksOf(s.a);
			if (!booking) throw new Error("no chunk");
			s.model.script(s.a.sessionId, [
				{ tool: "ask_operator", input: question([booking.chunkId]) },
				{ tool: "draft_brief", input: { brief } },
				{
					tool: "propose_memory",
					input: { contentMd: "Meridian uses Stripe." },
				},
				{
					reply: "Clients book a slot.",
					citations: [{ source: sourceFor(booking), cited_text: booking.text }],
				},
			]);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			const rows = await activityOf(tx, s.a.sessionId);
			expect(rows.map((r) => r.action).sort()).toEqual([
				"canon_question.asked",
				"client_memory.proposed",
				"intake.drafted_by_canon",
			]);
			const payloads = JSON.stringify(rows.map((r) => r.payload));
			for (const text of [
				"Payments",
				"Stripe or Square",
				"disagree",
				"Online booking",
				"A client books",
				"Meridian uses Stripe",
				"Clients book a slot",
				MEMORY.Meridian,
			]) {
				expect(payloads, text).not.toContain(text);
			}
		});
	});

	it("refuses every tool once the turn is over, and writes nothing", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			await withClientScope(tx, s.a.scope, (x) =>
				x
					.update(canonSession)
					.set({ turnStartedAt: null })
					.where(eq(canonSession.id, s.a.sessionId)),
			);
			const [chunk] = s.chunksOf(s.a);
			if (!chunk) throw new Error("no chunk");
			const call = canonTools({
				db: s.deps.db,
				clock: s.deps.clock,
				ids: s.deps.ids,
				clientId: s.a.scope,
				session: {
					id: s.a.sessionId,
					intakeId: s.a.intakeId,
					engagementId: s.a.engagementId,
				},
				chunkIds: new Set([chunk.chunkId]),
				requestId: randomUUID(),
			});
			for (const [name, input] of [
				["ask_operator", question([chunk.chunkId])],
				["draft_brief", { brief }],
				["propose_memory", { contentMd: "Too late." }],
			] as const) {
				expect(await call(name, input), name).toMatchObject({ isError: true });
			}
			const row = one(
				await tx.select().from(intake).where(eq(intake.id, s.a.intakeId)),
			);
			expect(row.proposedBrief).toBeNull();
			expect(await activityOf(tx, s.a.sessionId)).toEqual([]);
		});
	});

	it("stores no reply for a turn the sweep ended while the model ran", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const deps: CanonDeps = {
				...s.deps,
				model: {
					version: "sweep-mid-run",
					async *run() {
						await withClientScope(tx, s.a.scope, (x) =>
							x
								.update(canonSession)
								.set({ turnStartedAt: null })
								.where(eq(canonSession.id, s.a.sessionId)),
						);
						yield { kind: "reply", text: "Too late.", citations: [] };
					},
				},
			};
			expect(
				(await runCanonTurn(deps, inClient(s.a.scope), s.a.sessionId)).outcome,
			).toBe("skipped");
			expect(await messagesOf(tx, s.a)).toHaveLength(1);
		});
	});

	it("reads only the intake's live text files", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			const extra = async (
				name: string,
				mime: string,
				over: Partial<typeof file.$inferInsert> = {},
			) => {
				const bytes = new TextEncoder().encode(`${name} body text`);
				const put = await s.deps.blobs.put(blobPrefix(s.a.clientId), bytes);
				const id = randomUUID();
				await withClientScope(tx, s.a.scope, async (x) => {
					await x.insert(file).values({
						id,
						scope: "engagement",
						clientId: s.a.clientId,
						engagementId: s.a.engagementId,
						name,
						mime,
						bytes: bytes.length,
						sha256: put.sha256,
						storageKey: put.key,
						uploadedBy: s.userId,
						purgedAt: null,
						...stamp(clock),
						...over,
					});
					await x
						.insert(intakeFiles)
						.values({ intakeId: s.a.intakeId, fileId: id });
				});
			};
			await extra("notes.txt", "text/plain");
			await extra("photo.png", "image/png");
			await extra("deleted.md", "text/markdown", { deletedAt: clock.now() });
			await extra("purged.md", "text/markdown", {
				purgedAt: clock.now(),
				storageKey: null,
			});
			s.model.script(s.a.sessionId, []);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			const prompt = JSON.stringify(s.model.prompts[0]);
			expect(prompt).toContain("notes.txt body text");
			for (const gone of ["photo.png", "deleted.md", "purged.md"]) {
				expect(prompt, gone).not.toContain(gone);
			}
		});
	});

	it("filters memory by its own client even where row-level security does not apply", async () => {
		// As the owner, every policy is bypassed: only the turn's own filter stands.
		await inRollback(async (tx) => {
			const s = await seed(tx);
			await withClientScope(tx, s.b.scope, (x) =>
				x.insert(clientMemory).values({
					id: randomUUID(),
					clientId: s.b.clientId,
					contentMd: "Halcyon second secret.",
					status: "kept",
					...stamp(clock),
				}),
			);
			s.model.script(s.a.sessionId, []);
			await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
			const prompt = JSON.stringify(s.model.prompts[0]);
			expect(prompt).toContain(MEMORY.Meridian);
			expect(prompt).not.toContain("Halcyon");
		});
	});

	it("ticks: sweeps first, then runs every session mid-turn, and nothing else", async () => {
		await asApp(async (tx) => {
			const s = await seed(tx);
			await withClientScope(tx, s.b.scope, (x) =>
				x
					.update(canonSession)
					.set({ turnStartedAt: null })
					.where(eq(canonSession.id, s.b.sessionId)),
			);
			// Two more messages, so the reply's seq comes from the session, not a guess.
			await withClientScope(tx, s.a.scope, (x) =>
				x.insert(canonMessage).values([
					{
						id: randomUUID(),
						canonSessionId: s.a.sessionId,
						clientId: s.a.clientId,
						seq: 2,
						role: "canon",
						mode: "draft",
						parts: [],
						contentMd: "Earlier answer.",
						citations: [],
						createdAt: clock.now(),
					},
					{
						id: randomUUID(),
						canonSessionId: s.a.sessionId,
						clientId: s.a.clientId,
						seq: 3,
						role: "operator",
						mode: "draft",
						parts: [],
						contentMd: "One more thing.",
						citations: [],
						createdAt: clock.now(),
					},
				]),
			);
			s.model.script(s.a.sessionId, [{ reply: "Hello." }]);
			const results = await canonTick(s.deps);
			expect(s.sweeps).toEqual([600_000]);
			// Exactly one turn ran: the session with no turn was never picked up.
			expect(results.map((r) => r.outcome)).toEqual(["replied"]);
			expect(
				(await messagesOf(tx, s.a)).map((m) => [m.seq, m.contentMd]),
			).toEqual([
				[1, "Brief Meridian, please."],
				[2, "Earlier answer."],
				[3, "One more thing."],
				[4, "Hello."],
			]);
			expect(await messagesOf(tx, s.b)).toHaveLength(1);
			// A session whose turn is already over is not run again.
			expect(
				(await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId))
					.outcome,
			).toBe("skipped");
		});
	});

	describe("one run per turn (the prompt hash, 2026-10-21)", () => {
		const midTurnAgain = (tx: Tx, t: Tenant & { sessionId: string }) =>
			withClientScope(tx, t.scope, (x) =>
				x
					.update(canonSession)
					.set({ turnStartedAt: clock.now() })
					.where(eq(canonSession.id, t.sessionId)),
			);

		it("claims the turn, its seq and its prompt's hash, before the model runs", async () => {
			await asApp(async (tx) => {
				const s = await seed(tx);
				let seenByModel: unknown = "never ran";
				const model: CanonDeps["model"] = {
					version: FAKE_CANON_VERSION,
					async *run() {
						const row = await sessionRow(tx, s.a);
						seenByModel = [row.turnPromptSeq, row.turnPromptSha256];
						yield { kind: "reply", text: "Hello.", citations: [] };
					},
				};
				const result = await runCanonTurn(
					{ ...s.deps, model },
					inClient(s.a.scope),
					s.a.sessionId,
				);
				expect(result.outcome).toBe("replied");
				expect(result.promptSha256).toMatch(/^[0-9a-f]{64}$/);
				expect(seenByModel).toEqual([1, result.promptSha256]);
				expect(await sessionRow(tx, s.a)).toMatchObject({
					turnStartedAt: null,
					turnPromptSeq: 1,
					turnPromptSha256: result.promptSha256,
				});
			});
		});

		it("never runs a claimed turn again: a run that died mid-turn leaves its claim, and the next one calls no model", async () => {
			await asApp(async (tx) => {
				const s = await seed(tx);
				s.model.script(s.a.sessionId, [{ reply: "Hello." }]);
				await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
				// As if the process died before the turn's end committed.
				await midTurnAgain(tx, s.a);
				const before = s.model.prompts.length;
				const again = await runCanonTurn(
					s.deps,
					inClient(s.a.scope),
					s.a.sessionId,
				);
				expect(again.outcome).toBe("repeated");
				expect(s.model.prompts).toHaveLength(before);
				expect(await messagesOf(tx, s.a)).toHaveLength(2);
			});
		});

		it("runs a new turn: a later operator message is not held by the last turn's claim", async () => {
			await asApp(async (tx) => {
				const s = await seed(tx);
				s.model.script(s.a.sessionId, [{ reply: "Hello." }]);
				const first = await runCanonTurn(
					s.deps,
					inClient(s.a.scope),
					s.a.sessionId,
				);
				await withClientScope(tx, s.a.scope, (x) =>
					x.insert(canonMessage).values({
						id: randomUUID(),
						canonSessionId: s.a.sessionId,
						clientId: s.a.clientId,
						seq: 3,
						role: "operator",
						mode: "draft",
						parts: [],
						contentMd: "One more thing.",
						citations: [],
						createdAt: clock.now(),
					}),
				);
				await midTurnAgain(tx, s.a);
				s.model.script(s.a.sessionId, [{ reply: "Sure." }]);
				const second = await runCanonTurn(
					s.deps,
					inClient(s.a.scope),
					s.a.sessionId,
				);
				expect(second.outcome).toBe("replied");
				expect(second.promptSha256).not.toBe(first.promptSha256);
				expect(await sessionRow(tx, s.a)).toMatchObject({
					turnPromptSeq: 3,
					turnPromptSha256: second.promptSha256,
				});
			});
		});

		it("the sweep ends a claimed turn at once, and leaves an unclaimed one until its 10 minutes", async () => {
			await asApp(async (tx) => {
				const s = await seed(tx);
				s.model.script(s.a.sessionId, [{ reply: "Hello." }]);
				await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
				await midTurnAgain(tx, s.a);
				// b is mid-turn and was never claimed: a turn not yet run.
				expect(await sweepStuckCanonTurns(tx, clock)).toEqual([s.a.sessionId]);
				expect((await sessionRow(tx, s.a)).turnStartedAt).toBeNull();
				expect((await sessionRow(tx, s.b)).turnStartedAt).not.toBeNull();
			});
		});

		it("ticks a repeat to an end: the sweep clears it, and no model runs it", async () => {
			await asApp(async (tx) => {
				const s = await seed(tx);
				s.model.script(s.a.sessionId, [{ reply: "Hello." }]);
				await runCanonTurn(s.deps, inClient(s.a.scope), s.a.sessionId);
				await midTurnAgain(tx, s.a);
				await withClientScope(tx, s.b.scope, (x) =>
					x
						.update(canonSession)
						.set({ turnStartedAt: null })
						.where(eq(canonSession.id, s.b.sessionId)),
				);
				const before = s.model.prompts.length;
				const results = await canonTick({
					...s.deps,
					sweepStuckTurns: sweepStuckCanonTurns,
				});
				expect(results).toEqual([]);
				expect(s.model.prompts).toHaveLength(before);
				expect((await sessionRow(tx, s.a)).turnStartedAt).toBeNull();
			});
		});
	});
});
