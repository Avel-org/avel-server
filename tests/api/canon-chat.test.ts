import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { activityLog, canonSession, canonStep } from "../../src/db/schema";
import { withClientScope, withOpenScope } from "../../src/db/tx";
import { memoryBlobs } from "../../src/gateways/blob";
import { randomIds } from "../../src/lib/ids";
import { silentLogger } from "../../src/lib/logger";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import {
	type CanonDeps,
	canonTick,
	NO_MODEL_REPLY,
	offlineCanonModel,
	toolsFor,
} from "../../src/runner/canon";
import { seedTenants } from "../db/app-role";
import { seedCanonIdentity } from "../db/canon-fixtures";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

// The Canon chat round (J, 2026-10-20): open sessions with no client,
// client sessions with or without an intake, modes, titles, reopen,
// archive, the list across clients, and steps. Every request runs as
// avel_app, so row-level security is what keeps the scopes apart.

type Envelope<T = Record<string, unknown>> = {
	success: boolean;
	data: T;
	meta?: Record<string, unknown>;
	error?: { code: string; details?: { reason?: string } };
};
type Session = {
	id: string;
	scope: string;
	clientId: string | null;
	engagementId: string | null;
	intakeId: string | null;
	title: string | null;
	titleSetBy: string | null;
	mode: string;
	status: string;
	haltReason: string | null;
	archivedAt: string | null;
	lastActivityAt: string;
	closedAt: string | null;
};

const asApp = { asApp: true };

async function setUp(h: ApiHarness) {
	await h.signIn();
	const seeded = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
	await seedCanonIdentity(h.tx, "canon");
	const call = async <T = Session>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	) => {
		const res = await h.call(path, init);
		return { status: res.status, body: (await res.json()) as Envelope<T> };
	};
	const create = (body: Record<string, unknown>) =>
		call("/api/canon-sessions", { method: "POST", body });
	const post = (id: string, body: Record<string, unknown>) =>
		call(`/api/canon-sessions/${id}/messages`, { method: "POST", body });
	const verb = (id: string, v: string) =>
		call(`/api/canon-sessions/${id}/${v}`, { method: "POST" });
	return { ...seeded, call, create, post, verb };
}

const reason = (r: { body: Envelope<unknown> }) =>
	r.body.error?.details?.reason;

describe.skipIf(!process.env.DATABASE_URL)("Canon chat", () => {
	afterAll(closeApi);

	it("opens an open session with no client, in ask mode, and keeps it out of every client's scope", async () => {
		await withApi(async (h) => {
			const { a, create, call } = await setUp(h);
			const opened = await create({ scope: "open" });
			expect(opened.status, JSON.stringify(opened.body)).toBe(201);
			expect(opened.body.data).toMatchObject({
				scope: "open",
				clientId: null,
				engagementId: null,
				intakeId: null,
				mode: "ask",
				status: "open",
				title: null,
				archivedAt: null,
				lastActivityAt: clock.now().toISOString(),
			});
			const id = opened.body.data.id;
			expect((await call(`/api/canon-sessions/${id}`)).body.data.id).toBe(id);

			// The database, not the route: the open row is seen unscoped only.
			const inClient = await withClientScope(h.tx, a.scope, (s) =>
				s.select().from(canonSession).where(eq(canonSession.id, id)),
			);
			expect(inClient).toEqual([]);
			const unscoped = await withOpenScope(h.tx, (s) =>
				s.select().from(canonSession).where(eq(canonSession.id, id)),
			);
			expect(unscoped).toHaveLength(1);
			// And a client's row is not seen unscoped.
			const client = await create({ scope: "client", clientId: a.clientId });
			const hidden = await withOpenScope(h.tx, (s) =>
				s
					.select()
					.from(canonSession)
					.where(eq(canonSession.id, client.body.data.id)),
			);
			expect(hidden).toEqual([]);

			// An open session never drafts: there is no intake to draft.
			const draft = await create({ scope: "open", mode: "draft" });
			expect(draft.status).toBe(400);
		}, asApp);
	});

	it("opens client sessions on a client, an engagement or an intake, each checked against its parent", async () => {
		await withApi(async (h) => {
			const { a, b, create } = await setUp(h);
			const bare = await create({ scope: "client", clientId: a.clientId });
			expect(bare.body.data).toMatchObject({
				scope: "client",
				clientId: a.clientId,
				engagementId: null,
				intakeId: null,
				mode: "ask",
			});
			const onIntake = await create({
				scope: "client",
				clientId: a.clientId,
				intakeId: a.intakeId,
			});
			expect(onIntake.body.data).toMatchObject({
				engagementId: a.engagementId,
				intakeId: a.intakeId,
				mode: "draft",
			});
			// One open session per intake, as before.
			const second = await create({
				scope: "client",
				clientId: a.clientId,
				intakeId: a.intakeId,
			});
			expect(reason(second)).toBe("canon_session_open");

			const noIntake = await create({
				scope: "client",
				clientId: a.clientId,
				mode: "draft",
			});
			expect(noIntake.status).toBe(422);
			expect(reason(noIntake)).toBe("canon_mode_unavailable");
			// Another client's intake or engagement is 404, never 403.
			for (const body of [
				{ scope: "client", clientId: a.clientId, intakeId: b.intakeId },
				{ scope: "client", clientId: a.clientId, engagementId: b.engagementId },
				{
					scope: "client",
					clientId: a.clientId,
					engagementId: b.engagementId,
					intakeId: a.intakeId,
				},
				{ scope: "client", clientId: randomUUID() },
			]) {
				expect((await create(body)).status, JSON.stringify(body)).toBe(404);
			}
		}, asApp);
	});

	it("posts in a mode, logs the post without its text, and the turn answers in an open session", async () => {
		await withApi(async (h) => {
			const { create, post } = await setUp(h);
			const s = (await create({ scope: "open" })).body.data;
			const asked = await post(s.id, { contentMd: "What does a gate do?" });
			expect(asked.status, JSON.stringify(asked.body)).toBe(202);
			expect(asked.body.data).toMatchObject({
				role: "operator",
				mode: "ask",
				parts: [],
			});

			// Draft in an open session refuses: there is no intake to draft.
			const refused = await post(s.id, { contentMd: "x", mode: "draft" });
			expect(reason(refused)).toBe("canon_mode_unavailable");

			const [logged] = await h.tx
				.select({ payload: activityLog.payload })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.entityId, s.id),
						eq(activityLog.action, "canon_message.posted"),
					),
				);
			expect(logged?.payload).toEqual({
				sessionId: s.id,
				messageId: (asked.body.data as unknown as { id: string }).id,
				seq: 1,
				mode: "ask",
			});
			expect(JSON.stringify(logged?.payload)).not.toContain("gate");

			const deps: CanonDeps = {
				db: () => h.tx,
				clock,
				ids: randomIds,
				prices: DEFAULT_PRICE_BOOK,
				blobs: memoryBlobs(),
				model: offlineCanonModel(),
				logger: silentLogger(),
			};
			expect((await canonTick(deps)).map((r) => r.outcome)).toEqual([
				"replied",
			]);
			const messages = await h.call(`/api/canon-sessions/${s.id}/messages`);
			const body = (await messages.json()) as Envelope<
				Array<{ role: string; mode: string; contentMd: string }>
			>;
			expect(body.data.map((m) => [m.role, m.mode, m.contentMd])).toEqual([
				["operator", "ask", "What does a gate do?"],
				["canon", "ask", NO_MODEL_REPLY],
			]);
		}, asApp);
	});

	it("gives each mode its own tools, and name_session only while untitled", () => {
		const onIntake = { clientId: "c", intakeId: "i", title: "T" };
		expect(toolsFor("draft", onIntake)).toEqual([
			"ask_operator",
			"draft_brief",
			"propose_memory",
			"recommend_roster",
		]);
		expect(toolsFor("ask", onIntake)).toEqual([]);
		expect(toolsFor("fetch", onIntake)).toEqual(["fetch"]);
		expect(toolsFor("draft", { ...onIntake, intakeId: null })).toEqual([]);
		expect(
			toolsFor("draft", { clientId: null, intakeId: null, title: "T" }),
		).toEqual([]);
		expect(toolsFor("ask", { ...onIntake, title: null })).toEqual([
			"name_session",
		]);
		expect(toolsFor("fetch", { ...onIntake, title: null })).toEqual([
			"fetch",
			"name_session",
		]);
	});

	it("renames and changes mode, and Canon's title never overwrites the operator's", async () => {
		await withApi(async (h) => {
			const { a, create, call } = await setUp(h);
			const s = (await create({ scope: "client", clientId: a.clientId })).body
				.data;
			const patch = (body: unknown) =>
				call(`/api/canon-sessions/${s.id}`, { method: "PATCH", body });
			const renamed = await patch({ title: "  Booking questions  " });
			expect(renamed.body.data).toMatchObject({
				title: "Booking questions",
				titleSetBy: "operator",
			});
			expect(reason(await patch({ mode: "draft" }))).toBe(
				"canon_mode_unavailable",
			);
			expect((await patch({ mode: "fetch" })).body.data.mode).toBe("fetch");
			expect((await patch({})).status).toBe(400);
			expect((await patch({ title: "x".repeat(121) })).status).toBe(400);

			const [log] = await h.tx
				.select({ payload: activityLog.payload })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.entityId, s.id),
						eq(activityLog.action, "canon_session.renamed"),
					),
				);
			expect(log?.payload).toEqual({ sessionId: s.id, hadTitle: false });
		}, asApp);
	});

	it("reopens a closed or operator-halted session, never a token-ceiling halt", async () => {
		await withApi(async (h) => {
			const { a, create, verb } = await setUp(h);
			const s = (
				await create({
					scope: "client",
					clientId: a.clientId,
					intakeId: a.intakeId,
				})
			).body.data;
			expect(reason(await verb(s.id, "reopen"))).toBe("canon_session_open");
			expect((await verb(s.id, "close")).body.data.status).toBe("closed");
			const reopened = await verb(s.id, "reopen");
			expect(reopened.body.data).toMatchObject({
				status: "open",
				closedAt: null,
				haltReason: null,
			});
			expect((await verb(s.id, "halt")).body.data.haltReason).toBe("operator");
			expect((await verb(s.id, "reopen")).body.data.status).toBe("open");

			// While this one is closed, another opens on the same intake: then
			// reopening this one would make two.
			await verb(s.id, "close");
			const other = await create({
				scope: "client",
				clientId: a.clientId,
				intakeId: a.intakeId,
			});
			expect(other.status).toBe(201);
			expect(reason(await verb(s.id, "reopen"))).toBe("canon_session_open");

			await withClientScope(h.tx, a.scope, (tx) =>
				tx
					.update(canonSession)
					.set({
						status: "halted",
						haltReason: "token_hard_ceiling",
						closedAt: clock.now(),
					})
					.where(eq(canonSession.id, other.body.data.id)),
			);
			expect(reason(await verb(other.body.data.id, "reopen"))).toBe(
				"canon_session_final",
			);
		}, asApp);
	});

	it("archives (closing an open session), hides it from the list, finds it by title, and unarchives", async () => {
		await withApi(async (h) => {
			const { a, create, verb, call } = await setUp(h);
			const s = (await create({ scope: "open" })).body.data;
			await call(`/api/canon-sessions/${s.id}`, {
				method: "PATCH",
				body: { title: "Pricing ideas" },
			});
			const archived = await verb(s.id, "archive");
			expect(archived.body.data).toMatchObject({ status: "closed" });
			expect(archived.body.data.archivedAt).not.toBeNull();
			// Archiving again changes nothing.
			expect((await verb(s.id, "archive")).body.data.archivedAt).toBe(
				archived.body.data.archivedAt,
			);
			const list = (q: string) =>
				call<Array<{ id: string }>>(`/api/canon-sessions?${q}`);
			const ids = async (q: string) =>
				(await list(q)).body.data.map((r) => r.id);
			expect(await ids("scope=open")).not.toContain(s.id);
			expect(await ids("scope=open&archived=true")).toEqual([s.id]);
			expect(await ids("archived=true&q=pricing")).toEqual([s.id]);
			expect(await ids("archived=true&q=nothing")).toEqual([]);

			const back = await verb(s.id, "unarchive");
			expect(back.body.data).toMatchObject({
				archivedAt: null,
				status: "closed",
			});
			expect(await ids("scope=open")).toEqual([s.id]);

			const kinds = await h.tx
				.select({ action: activityLog.action })
				.from(activityLog)
				.where(eq(activityLog.entityId, s.id))
				.orderBy(asc(activityLog.at), asc(activityLog.id));
			expect(kinds.map((k) => k.action)).toEqual([
				"canon_session.opened",
				"canon_session.renamed",
				"canon_session.closed",
				"canon_session.archived",
				"canon_session.unarchived",
			]);
			void a;
		}, asApp);
	});

	it("lists sessions across clients, filtered and paged, newest activity first", async () => {
		await withApi(async (h) => {
			const { a, b, create, call } = await setUp(h);
			const open = (await create({ scope: "open" })).body.data.id;
			const ofA = (await create({ scope: "client", clientId: a.clientId })).body
				.data.id;
			const ofB = (await create({ scope: "client", clientId: b.clientId })).body
				.data.id;
			const page = (q: string) =>
				call<Array<{ id: string; scope: string; clientId: string | null }>>(
					`/api/canon-sessions?${q}`,
				);
			const mine = new Set([open, ofA, ofB]);
			const all = (await page("limit=100")).body.data.filter((r) =>
				mine.has(r.id),
			);
			// One fixed clock: the sort falls back to id, descending.
			expect(all.map((r) => r.id)).toEqual([open, ofA, ofB].sort().reverse());
			expect(
				(await page(`clientId=${a.clientId}`)).body.data.map((r) => r.id),
			).toEqual([ofA]);
			expect(
				(await page("scope=client&limit=100")).body.data.every(
					(r) => r.scope === "client",
				),
			).toBe(true);
			const first = await page(`clientId=${b.clientId}&limit=1`);
			expect(first.body.meta).toMatchObject({ total: 1, nextCursor: null });

			// Paged by cursor across clients.
			const one = await page("limit=1&scope=client");
			const cursor = one.body.meta?.nextCursor as string;
			expect(cursor).toBeTruthy();
			const next = await page(`limit=1&scope=client&cursor=${cursor}`);
			expect(next.body.data[0]?.id).not.toBe(one.body.data[0]?.id);
			expect((await page("cursor=junk")).status).toBe(400);
		}, asApp);
	});

	it("reads steps after a seq, in its own scope only", async () => {
		await withApi(async (h) => {
			const { a, b, create, call } = await setUp(h);
			const s = (await create({ scope: "client", clientId: a.clientId })).body
				.data;
			await withClientScope(h.tx, a.scope, (tx) =>
				tx.insert(canonStep).values(
					[1, 2, 3].map((seq) => ({
						id: randomUUID(),
						canonSessionId: s.id,
						clientId: a.clientId,
						turn: 1,
						seq,
						kind: seq === 2 ? ("tool_call" as const) : ("text" as const),
						label: `Step ${seq}`,
						detail: seq === 2 ? { tool: "draft_brief" } : { text: "Hi" },
						startedAt: clock.now(),
						endedAt: null,
						tokensIn: null,
						tokensOut: null,
						createdAt: clock.now(),
					})),
				),
			);
			const steps = await call<Array<{ seq: number; kind: string }>>(
				`/api/canon-sessions/${s.id}/steps?afterSeq=1`,
			);
			expect(steps.body.data.map((r) => [r.seq, r.kind])).toEqual([
				[2, "tool_call"],
				[3, "text"],
			]);
			expect(steps.body.meta).toEqual({ lastSeq: 3 });

			// A step cannot name another client's scope, or be changed.
			await expect(
				withClientScope(h.tx, b.scope, (tx) =>
					tx.insert(canonStep).values({
						id: randomUUID(),
						canonSessionId: s.id,
						clientId: b.clientId,
						turn: 1,
						seq: 4,
						kind: "text",
						label: "x",
						detail: {},
						startedAt: clock.now(),
						createdAt: clock.now(),
					}),
				),
			).rejects.toThrow();
			await expect(
				withClientScope(h.tx, a.scope, (tx) =>
					tx
						.update(canonStep)
						.set({ label: "changed" })
						.where(eq(canonStep.canonSessionId, s.id)),
				),
			).rejects.toThrow();
		}, asApp);
	});
});
