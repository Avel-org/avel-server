import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { sweepStuckCanonTurns } from "../../src/db/canon";
import {
	activityLog,
	canonMessage,
	canonQuestion,
	canonSession,
	clientMemory,
	file,
	intake,
	intakeFiles,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { withClientScope } from "../../src/db/tx";
import { FAKE_HARNESS_MODEL } from "../../src/runner/harness";
import { seedTenants } from "../db/app-role";
import {
	questionValues,
	seedCanonIdentity,
	sessionValues,
} from "../db/canon-fixtures";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

// Canon's routes (src/routes/canon.ts), every one as avel_app, so the
// client scope is what makes them work.

type Tenant = Awaited<ReturnType<typeof seedTenants>>["a"];
type Envelope<T = Record<string, unknown>> = {
	success: boolean;
	data: T;
	meta?: Record<string, unknown>;
	error?: { code: string; details?: { reason?: string; body?: unknown } };
};

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CONTENT = "Use GitHub sign-in; the client has no SSO.";

async function setUp(h: ApiHarness, opts: { canon?: boolean } = {}) {
	await h.signIn();
	const seeded = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
	if (opts.canon !== false) await seedCanonIdentity(h.tx, "canon");
	const json = async <T = Record<string, unknown>>(res: Response) => ({
		status: res.status,
		headers: res.headers,
		body: (await res.json()) as Envelope<T>,
	});
	const call = <T = Record<string, unknown>>(
		path: string,
		init: {
			method?: string;
			body?: unknown;
			headers?: Record<string, string>;
		} = {},
	) => h.call(path, init).then((r) => json<T>(r));
	return { ...seeded, call };
}

/** Attaches a file with these bytes' hash to the intake, as the upload route would. */
async function attachFile(
	h: ApiHarness,
	t: Tenant,
	userId: string,
	sha256: string,
	over: Partial<typeof file.$inferInsert> = {},
) {
	const id = randomUUID();
	await withClientScope(h.tx, t.scope, async (s) => {
		await s.insert(file).values({
			id,
			scope: "engagement",
			clientId: t.clientId,
			engagementId: t.engagementId,
			name: `${id.slice(0, 4)}.md`,
			mime: "text/markdown",
			bytes: 10,
			sha256,
			storageKey: `clients/${t.clientId}/${sha256}`,
			uploadedBy: userId,
			purgedAt: null,
			...stamp(clock),
			...over,
		});
		await s.insert(intakeFiles).values({ intakeId: t.intakeId, fileId: id });
	});
	return id;
}

/** Ends Canon's turn and writes its reply, as the harness will. */
async function canonReplies(
	h: ApiHarness,
	t: Tenant,
	sessionId: string,
	seq: number,
	citations: Array<{ chunkId: string; heading: string[]; quote: string }>,
) {
	await withClientScope(h.tx, t.scope, async (s) => {
		await s
			.update(canonSession)
			.set({ turnStartedAt: null })
			.where(eq(canonSession.id, sessionId));
		await s.insert(canonMessage).values({
			id: randomUUID(),
			canonSessionId: sessionId,
			clientId: t.clientId,
			seq,
			role: "canon",
			mode: "draft",
			parts: [],
			contentMd: "Here is what the brief says.",
			citations,
			createdAt: clock.now(),
		});
	});
}

const reasonOf = (body: Envelope) => body.error?.details?.reason;

describe.skipIf(!process.env.DATABASE_URL)("Canon's routes", () => {
	afterAll(closeApi);
	const asApp = { asApp: true };

	describe("sessions", () => {
		it("opens a session on a draft intake with Canon's frozen identity, one open at a time", async () => {
			await withApi(async (h) => {
				const { a, call } = await setUp(h);
				const opened = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
					method: "POST",
					body: {},
				});
				expect(opened.status).toBe(201);
				expect(opened.body.data).toMatchObject({
					intakeId: a.intakeId,
					status: "open",
					haltReason: null,
					model: FAKE_HARNESS_MODEL,
					estimatedTokens: 60_000,
					tokenSoftCeiling: 90_000,
					tokenHardCeiling: 180_000,
					tokensUsed: 0,
					spendUsd: 0,
					turn: "idle",
					lastSeq: 0,
					openQuestions: 0,
					openedBy: { kind: "operator", display: h.operator.login },
					closedAt: null,
				});
				const id = opened.body.data.id as string;
				const intakeWire = await call(`/api/intakes/${a.intakeId}`);
				expect(intakeWire.body.data).toMatchObject({
					openCanonSessionId: id,
					draftedByCanonSessionId: null,
					recommendedRoster: null,
				});
				const second = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
					method: "POST",
					body: {},
				});
				expect(second.status).toBe(422);
				expect(reasonOf(second.body)).toBe("canon_session_open");
				const listed = await call(`/api/intakes/${a.intakeId}/canon-sessions`);
				expect(
					(listed.body.data as unknown as { id: string }[]).map((s) => s.id),
				).toEqual([id]);
				expect(listed.body.meta).toEqual({ nextCursor: null, total: 1 });
			}, asApp);
		});

		it("replays an open by its key, refuses the key with another body, and scopes it to the intake", async () => {
			await withApi(async (h) => {
				const { a, b, call } = await setUp(h);
				const key = randomUUID();
				const open = (intakeId: string, body: unknown) =>
					call(`/api/intakes/${intakeId}/canon-sessions`, {
						method: "POST",
						body,
						headers: { "idempotency-key": key },
					});
				const first = await open(a.intakeId, { estimatedTokens: 1000 });
				expect(first.status).toBe(201);
				const again = await open(a.intakeId, { estimatedTokens: 1000 });
				expect(again.status).toBe(200);
				expect(again.headers.get("idempotency-replayed")).toBe("true");
				expect(again.body.data.id).toBe(first.body.data.id);
				const other = await open(a.intakeId, { estimatedTokens: 2000 });
				expect(other.status).toBe(409);
				expect(other.body.error?.code).toBe("IDEMPOTENCY_REPLAY");
				const elsewhere = await open(b.intakeId, { estimatedTokens: 1000 });
				expect(elsewhere.status).toBe(201);
				expect(elsewhere.body.data.id).not.toBe(first.body.data.id);
			}, asApp);
		});

		it("refuses with no Canon identity, on an intake past draft, and with ceilings below the estimate", async () => {
			await withApi(async (h) => {
				const { a, call } = await setUp(h, { canon: false });
				const path = `/api/intakes/${a.intakeId}/canon-sessions`;
				const noIdentity = await call(path, { method: "POST", body: {} });
				expect(noIdentity.status).toBe(422);
				expect(reasonOf(noIdentity.body)).toBe("agent_identity_missing");
				await seedCanonIdentity(h.tx, "canon");
				const low = await call(path, {
					method: "POST",
					body: { estimatedTokens: 1000, tokenSoftCeiling: 999 },
				});
				expect(low.status).toBe(400);
				await h.tx
					.update(intake)
					.set({ status: "proposed" })
					.where(eq(intake.id, a.intakeId));
				const notDraft = await call(path, { method: "POST", body: {} });
				expect(notDraft.status).toBe(422);
				expect(reasonOf(notDraft.body)).toBe("intake_not_draft");
			}, asApp);
		});

		it("takes a message as Canon's turn, refuses a second until Canon replies, and resolves its citations", async () => {
			await withApi(async (h) => {
				const { userId, a, call } = await setUp(h);
				const fileId = await attachFile(h, a, userId, SHA_A);
				const session = await call(
					`/api/intakes/${a.intakeId}/canon-sessions`,
					{
						method: "POST",
						body: {},
					},
				);
				const id = session.body.data.id as string;
				const post = (contentMd: string) =>
					call(`/api/canon-sessions/${id}/messages`, {
						method: "POST",
						body: { contentMd },
					});
				const first = await post(CONTENT);
				expect(first.status).toBe(202);
				expect(first.body.data).toMatchObject({
					seq: 1,
					role: "operator",
					contentMd: CONTENT,
					citations: [],
				});
				expect(
					(await call(`/api/canon-sessions/${id}`)).body.data,
				).toMatchObject({
					turn: "canon",
					lastSeq: 1,
				});
				const busy = await post("And another thing.");
				expect(busy.status).toBe(422);
				expect(reasonOf(busy.body)).toBe("canon_turn_running");
				const close = await call(`/api/canon-sessions/${id}/close`, {
					method: "POST",
				});
				expect(reasonOf(close.body)).toBe("canon_turn_running");

				await canonReplies(h, a, id, 2, [
					{
						chunkId: `${SHA_A}:3-7`,
						heading: ["Auth", "Sign-in"],
						quote: "GitHub",
					},
				]);
				const messages = await call(`/api/canon-sessions/${id}/messages`);
				expect(messages.body.meta).toEqual({ lastSeq: 2 });
				const data = messages.body.data as unknown as Array<
					Record<string, unknown>
				>;
				expect(data.map((m) => m.seq)).toEqual([1, 2]);
				expect(data[1]?.citations).toEqual([
					{
						fileId,
						fileName: `${fileId.slice(0, 4)}.md`,
						purged: false,
						chunkId: `${SHA_A}:3-7`,
						heading: ["Auth", "Sign-in"],
						quote: "GitHub",
					},
				]);
				const after = await call(
					`/api/canon-sessions/${id}/messages?afterSeq=1`,
				);
				expect((after.body.data as unknown as unknown[]).length).toBe(1);
				expect((await post("Next.")).body.data).toMatchObject({ seq: 3 });
			}, asApp);
		});

		it("replays a message by its key, and refuses the key with another body", async () => {
			await withApi(async (h) => {
				const { a, call } = await setUp(h);
				const session = await call(
					`/api/intakes/${a.intakeId}/canon-sessions`,
					{
						method: "POST",
						body: {},
					},
				);
				const id = session.body.data.id as string;
				const key = randomUUID();
				const post = (contentMd: string) =>
					call(`/api/canon-sessions/${id}/messages`, {
						method: "POST",
						body: { contentMd },
						headers: { "idempotency-key": key },
					});
				const first = await post(CONTENT);
				expect(first.status).toBe(202);
				const again = await post(CONTENT);
				expect(again.status).toBe(200);
				expect(again.headers.get("idempotency-replayed")).toBe("true");
				expect(again.body.data.id).toBe(first.body.data.id);
				expect((await post("Something else.")).status).toBe(409);
			}, asApp);
		});

		it("resolves a passage to a live copy over a purged one, and 500s a passage of no file", async () => {
			await withApi(async (h) => {
				const { userId, a, call } = await setUp(h);
				await attachFile(h, a, userId, SHA_A, {
					purgedAt: clock.now(),
					storageKey: null,
				});
				const liveCopy = await attachFile(h, a, userId, SHA_A, {
					createdAt: new Date(clock.now().getTime() + 1000),
				});
				const session = await call(
					`/api/intakes/${a.intakeId}/canon-sessions`,
					{
						method: "POST",
						body: {},
					},
				);
				const id = session.body.data.id as string;
				await canonReplies(h, a, id, 1, [
					{ chunkId: `${SHA_A}:1-2`, heading: [], quote: "x" },
				]);
				const listed = await call(`/api/canon-sessions/${id}/messages`);
				const [message] = listed.body.data as unknown as Array<{
					citations: Array<{ fileId: string; purged: boolean }>;
				}>;
				expect(message?.citations[0]).toMatchObject({
					fileId: liveCopy,
					purged: false,
				});
				await canonReplies(h, a, id, 2, [
					{ chunkId: `${SHA_B}:1-2`, heading: [], quote: "y" },
				]);
				expect((await call(`/api/canon-sessions/${id}/messages`)).status).toBe(
					500,
				);
			}, asApp);
		});

		it("halts mid-turn, and then refuses every move on the session", async () => {
			await withApi(async (h) => {
				const { a, call } = await setUp(h);
				const session = await call(
					`/api/intakes/${a.intakeId}/canon-sessions`,
					{
						method: "POST",
						body: {},
					},
				);
				const id = session.body.data.id as string;
				await call(`/api/canon-sessions/${id}/messages`, {
					method: "POST",
					body: { contentMd: CONTENT },
				});
				const halted = await call(`/api/canon-sessions/${id}/halt`, {
					method: "POST",
				});
				expect(halted.status).toBe(200);
				expect(halted.body.data).toMatchObject({
					status: "halted",
					haltReason: "operator",
					turn: "idle",
				});
				expect(halted.body.data.closedAt).not.toBeNull();
				for (const res of [
					await call(`/api/canon-sessions/${id}/messages`, {
						method: "POST",
						body: { contentMd: "Hello?" },
					}),
					await call(`/api/canon-sessions/${id}/close`, { method: "POST" }),
					await call(`/api/canon-sessions/${id}/halt`, { method: "POST" }),
				]) {
					expect(res.status).toBe(422);
					expect(reasonOf(res.body)).toBe("canon_session_not_open");
				}
				// Halted, the intake can have a new session.
				const next = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
					method: "POST",
					body: {},
				});
				expect(next.status).toBe(201);
			}, asApp);
		});

		it("closes a session between turns", async () => {
			await withApi(async (h) => {
				const { a, call } = await setUp(h);
				const session = await call(
					`/api/intakes/${a.intakeId}/canon-sessions`,
					{
						method: "POST",
						body: {},
					},
				);
				const id = session.body.data.id as string;
				const closed = await call(`/api/canon-sessions/${id}/close`, {
					method: "POST",
				});
				expect(closed.status).toBe(200);
				expect(closed.body.data).toMatchObject({
					status: "closed",
					haltReason: null,
				});
				const intakeWire = await call(`/api/intakes/${a.intakeId}`);
				expect(intakeWire.body.data.openCanonSessionId).toBeNull();
			}, asApp);
		});
	});

	describe("questions", () => {
		async function withQuestions(h: ApiHarness) {
			const setup = await setUp(h);
			const { a, userId, call } = setup;
			const fileId = await attachFile(h, a, userId, SHA_A);
			const session = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
				method: "POST",
				body: {},
			});
			const sessionId = session.body.data.id as string;
			const at = (ms: number) => new Date(clock.now().getTime() + ms);
			const qs = [
				questionValues(a, sessionId, {
					header: "Auth",
					createdAt: at(0),
					sourceChunkIds: [`${SHA_A}:4-9`],
				}),
				questionValues(a, sessionId, { header: "Hosting", createdAt: at(1) }),
				questionValues(a, sessionId, {
					header: "Billing",
					createdAt: at(2),
					multiSelect: true,
				}),
			];
			await withClientScope(h.tx, a.scope, (s) =>
				s.insert(canonQuestion).values(qs),
			);
			return {
				...setup,
				fileId,
				sessionId,
				ids: qs.map((q) => q.id as string),
			};
		}

		it("lists the intake's questions oldest first, with every status's count and their sources", async () => {
			await withApi(async (h) => {
				const { a, call, ids, fileId, sessionId } = await withQuestions(h);
				const listed = await call(`/api/intakes/${a.intakeId}/canon-questions`);
				const data = listed.body.data as unknown as Array<
					Record<string, unknown>
				>;
				expect(data.map((q) => q.id)).toEqual(ids);
				expect(listed.body.meta).toEqual({
					nextCursor: null,
					total: 3,
					counts: { open: 3, answered: 0, acknowledged: 0, dismissed: 0 },
				});
				expect(data[0]?.sources).toEqual([
					{
						fileId,
						fileName: `${fileId.slice(0, 4)}.md`,
						purged: false,
						chunkId: `${SHA_A}:4-9`,
					},
				]);
				const session = await call(`/api/canon-sessions/${sessionId}`);
				expect(session.body.data.openQuestions).toBe(3);
			}, asApp);
		});

		it("answers by the rules, decides once, and counts by status", async () => {
			await withApi(async (h) => {
				const { a, call, ids } = await withQuestions(h);
				const [auth, hosting, billing] = ids as [string, string, string];
				const two = await call(`/api/canon-questions/${auth}/answer`, {
					method: "POST",
					body: { selected: ["GitHub", "Email"] },
				});
				expect(two.status).toBe(400);
				expect(two.body.error?.details?.body).toEqual([
					{ path: ["selected"], message: expect.any(String) },
				]);
				const answered = await call(`/api/canon-questions/${auth}/answer`, {
					method: "POST",
					body: { selected: ["GitHub"], effectMd: "Sign-in is GitHub only." },
				});
				expect(answered.status).toBe(200);
				expect(answered.body.data).toMatchObject({
					status: "answered",
					answer: { selected: ["GitHub"], other: null },
					effectMd: "Sign-in is GitHub only.",
					decidedBy: { kind: "operator", display: h.operator.login },
				});
				const again = await call(`/api/canon-questions/${auth}/answer`, {
					method: "POST",
					body: { selected: ["Email"] },
				});
				expect(again.status).toBe(422);
				expect(reasonOf(again.body)).toBe("canon_question_not_open");
				expect(
					(
						await call(`/api/canon-questions/${hosting}/acknowledge`, {
							method: "POST",
							body: {},
						})
					).body.data.status,
				).toBe("acknowledged");
				expect(
					(
						await call(`/api/canon-questions/${billing}/dismiss`, {
							method: "POST",
							body: { effectMd: "Out of scope." },
						})
					).body.data,
				).toMatchObject({
					status: "dismissed",
					effectMd: "Out of scope.",
					answer: null,
				});
				const open = await call(
					`/api/intakes/${a.intakeId}/canon-questions?status=open`,
				);
				expect(open.body.data).toEqual([]);
				expect(open.body.meta).toMatchObject({
					total: 0,
					counts: { open: 0, answered: 1, acknowledged: 1, dismissed: 1 },
				});
			}, asApp);
		});
	});

	describe("client memory", () => {
		it("writes, proposes, keeps, edits and removes, each once", async () => {
			await withApi(async (h) => {
				const { a, call } = await setUp(h);
				const session = await call(
					`/api/intakes/${a.intakeId}/canon-sessions`,
					{
						method: "POST",
						body: {},
					},
				);
				const sessionId = session.body.data.id as string;
				const written = await call(`/api/clients/${a.clientId}/memory`, {
					method: "POST",
					body: { contentMd: "Invoices go to finance@." },
				});
				expect(written.status).toBe(201);
				expect(written.body.data).toMatchObject({
					clientId: a.clientId,
					status: "kept",
					proposedBy: null,
					decidedBy: { kind: "operator" },
				});
				const proposedId = randomUUID();
				await withClientScope(h.tx, a.scope, (s) =>
					s.insert(clientMemory).values({
						id: proposedId,
						clientId: a.clientId,
						contentMd: CONTENT,
						status: "proposed",
						proposedByCanonSessionId: sessionId,
						decidedBy: null,
						decidedAt: null,
						createdAt: new Date(clock.now().getTime() + 1000),
						updatedAt: new Date(clock.now().getTime() + 1000),
					}),
				);
				const listed = await call(`/api/clients/${a.clientId}/memory`);
				const data = listed.body.data as unknown as Array<
					Record<string, unknown>
				>;
				expect(data.map((m) => m.id)).toEqual([
					proposedId,
					written.body.data.id,
				]);
				expect(data[0]?.proposedBy).toMatchObject({
					kind: "canon",
					canonSessionId: sessionId,
					display: "Canon",
				});
				const proposed = await call(
					`/api/clients/${a.clientId}/memory?status=proposed`,
				);
				expect(proposed.body.meta?.total).toBe(1);

				const keep = () =>
					call(`/api/client-memory/${proposedId}/keep`, { method: "POST" });
				expect((await keep()).body.data.status).toBe("kept");
				const keptAgain = await keep();
				expect(reasonOf(keptAgain.body)).toBe("client_memory_not_proposed");
				const edit = (contentMd: string) =>
					call(`/api/client-memory/${proposedId}`, {
						method: "PATCH",
						body: { contentMd },
					});
				expect((await edit("Edited.")).body.data).toMatchObject({
					contentMd: "Edited.",
					status: "kept",
				});
				const remove = () =>
					call(`/api/client-memory/${proposedId}/remove`, { method: "POST" });
				expect((await remove()).body.data.status).toBe("removed");
				const removedAgain = await remove();
				expect(removedAgain.status).toBe(200);
				const editRemoved = await edit("Too late.");
				expect(editRemoved.status).toBe(422);
				expect(reasonOf(editRemoved.body)).toBe("client_memory_removed");
				const logs = await h.tx
					.select({ action: activityLog.action })
					.from(activityLog)
					.where(eq(activityLog.entityId, proposedId));
				expect(logs.map((l) => l.action)).toEqual([
					"client_memory.kept",
					"client_memory.edited",
					"client_memory.removed",
				]);
			}, asApp);
		});
	});

	it("answers 404 for an id no scope can see, and lists only the named intake's or client's rows", async () => {
		await withApi(async (h) => {
			const { a, b, call } = await setUp(h);
			const s = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
				method: "POST",
				body: {},
			});
			await call(`/api/clients/${a.clientId}/memory`, {
				method: "POST",
				body: { contentMd: "A's fact." },
			});
			expect(s.status).toBe(201);
			const unknown = randomUUID();
			for (const [method, path, body] of [
				["GET", `/api/canon-sessions/${unknown}`, undefined],
				["POST", `/api/canon-sessions/${unknown}/close`, undefined],
				["POST", `/api/canon-sessions/${unknown}/halt`, undefined],
				["GET", `/api/canon-sessions/${unknown}/messages`, undefined],
				["POST", `/api/canon-sessions/${unknown}/messages`, { contentMd: "x" }],
				["POST", `/api/canon-questions/${unknown}/answer`, { selected: [] }],
				["POST", `/api/canon-questions/${unknown}/acknowledge`, {}],
				["POST", `/api/canon-questions/${unknown}/dismiss`, {}],
				["POST", `/api/client-memory/${unknown}/keep`, undefined],
				["POST", `/api/client-memory/${unknown}/remove`, undefined],
				["PATCH", `/api/client-memory/${unknown}`, { contentMd: "x" }],
				["POST", `/api/intakes/${unknown}/canon-sessions`, {}],
				["GET", `/api/intakes/${unknown}/canon-sessions`, undefined],
				["GET", `/api/intakes/${unknown}/canon-questions`, undefined],
				["GET", `/api/clients/${unknown}/memory`, undefined],
				["POST", `/api/clients/${unknown}/memory`, { contentMd: "x" }],
			] as const) {
				const res = await call(path, { method, body });
				expect(res.status, `${method} ${path}`).toBe(404);
			}
			const ofB = [
				await call(`/api/intakes/${b.intakeId}/canon-sessions`),
				await call(`/api/intakes/${b.intakeId}/canon-questions`),
				await call(`/api/clients/${b.clientId}/memory`),
			];
			for (const res of ofB) {
				expect(res.status).toBe(200);
				expect(res.body.data).toEqual([]);
			}
		}, asApp);
	});

	it("logs ids, hashes, statuses and counts only: never content", async () => {
		await withApi(async (h) => {
			const { a, call } = await setUp(h);
			const s1 = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
				method: "POST",
				body: {},
			});
			const id1 = s1.body.data.id as string;
			await call(`/api/canon-sessions/${id1}/close`, { method: "POST" });
			const s2 = await call(`/api/intakes/${a.intakeId}/canon-sessions`, {
				method: "POST",
				body: {},
			});
			const id2 = s2.body.data.id as string;
			const qs = [0, 1, 2].map((i) =>
				questionValues(a, id2, {
					header: `Q${i}`,
					question: CONTENT,
					reason: CONTENT,
				}),
			);
			await withClientScope(h.tx, a.scope, (s) =>
				s.insert(canonQuestion).values(qs),
			);
			await call(`/api/canon-questions/${qs[0]?.id}/answer`, {
				method: "POST",
				body: { selected: ["GitHub"], other: undefined, effectMd: CONTENT },
			});
			await call(`/api/canon-questions/${qs[1]?.id}/acknowledge`, {
				method: "POST",
				body: { effectMd: CONTENT },
			});
			await call(`/api/canon-questions/${qs[2]?.id}/dismiss`, {
				method: "POST",
				body: {},
			});
			await call(`/api/canon-sessions/${id2}/halt`, { method: "POST" });
			const m = await call(`/api/clients/${a.clientId}/memory`, {
				method: "POST",
				body: { contentMd: CONTENT },
			});
			const memoryId = m.body.data.id as string;
			await call(`/api/client-memory/${memoryId}`, {
				method: "PATCH",
				body: { contentMd: `${CONTENT} Edited.` },
			});
			await call(`/api/client-memory/${memoryId}/remove`, { method: "POST" });
			const proposedId = randomUUID();
			await withClientScope(h.tx, a.scope, (s) =>
				s.insert(clientMemory).values({
					id: proposedId,
					clientId: a.clientId,
					contentMd: CONTENT,
					status: "proposed",
					proposedByCanonSessionId: id2,
					decidedBy: null,
					decidedAt: null,
					...stamp(clock),
				}),
			);
			await call(`/api/client-memory/${proposedId}/keep`, { method: "POST" });

			const rows = await h.tx
				.select({ action: activityLog.action, payload: activityLog.payload })
				.from(activityLog)
				.where(
					inArray(activityLog.entityType, [
						"canon_session",
						"canon_question",
						"client_memory",
					]),
				);
			expect(new Set(rows.map((r) => r.action))).toEqual(
				new Set([
					"canon_session.opened",
					"canon_session.closed",
					"canon_session.halted",
					"canon_question.answered",
					"canon_question.acknowledged",
					"canon_question.dismissed",
					"client_memory.written",
					"client_memory.edited",
					"client_memory.removed",
					"client_memory.kept",
				]),
			);
			const UUID =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
			const HEX = /^[0-9a-f]{64}$/;
			const WORDS = new Set([
				"open",
				"closed",
				"halted",
				"operator",
				"answered",
				"acknowledged",
				"dismissed",
				"proposed",
				"kept",
				"removed",
				// A session's scope and mode: fixed values, never client text.
				"client",
				"draft",
			]);
			const leaves = (v: unknown): unknown[] =>
				v !== null && typeof v === "object"
					? Object.values(v as object).flatMap(leaves)
					: [v];
			for (const r of rows) {
				for (const leaf of leaves(r.payload)) {
					const fine =
						leaf === null ||
						typeof leaf === "number" ||
						typeof leaf === "boolean" ||
						(typeof leaf === "string" &&
							(UUID.test(leaf) || HEX.test(leaf) || WORDS.has(leaf)));
					expect(fine, `${r.action}: ${JSON.stringify(leaf)}`).toBe(true);
				}
				expect(JSON.stringify(r.payload)).not.toContain("GitHub");
				expect(JSON.stringify(r.payload)).not.toContain("sign-in");
			}
		}, asApp);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("sweepStuckCanonTurns", () => {
	afterAll(closeApi);

	it("ends a turn older than the limit in every client's scope, and leaves a recent one", async () => {
		await withApi(
			async (h) => {
				const { a, b } = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
				const userId = (await seedTenants(h.tx, ["Other"])).userId;
				const identity = await seedCanonIdentity(h.tx);
				const old = new Date(clock.now().getTime() - 11 * 60 * 1000);
				const recent = new Date(clock.now().getTime() - 60 * 1000);
				const sa = sessionValues(a, userId, identity, { turnStartedAt: old });
				const sb = sessionValues(b, userId, identity, {
					turnStartedAt: recent,
				});
				await withClientScope(h.tx, a.scope, (s) =>
					s.insert(canonSession).values(sa),
				);
				await withClientScope(h.tx, b.scope, (s) =>
					s.insert(canonSession).values(sb),
				);
				const cleared = await sweepStuckCanonTurns(h.tx, clock);
				expect(cleared).toContain(sa.id);
				expect(cleared).not.toContain(sb.id);
				const turnOf = (t: Tenant, id: string) =>
					withClientScope(h.tx, t.scope, (s) =>
						s
							.select({
								at: canonSession.turnStartedAt,
								status: canonSession.status,
							})
							.from(canonSession)
							.where(eq(canonSession.id, id)),
					);
				expect(await turnOf(a, sa.id as string)).toEqual([
					{ at: null, status: "open" },
				]);
				expect(await turnOf(b, sb.id as string)).toEqual([
					{ at: recent, status: "open" },
				]);
			},
			{ asApp: true },
		);
	});
});
