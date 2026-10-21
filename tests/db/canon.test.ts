import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCanonQuestions } from "../../src/db/canon";
import { closeDb } from "../../src/db/client";
import {
	canonMessage,
	canonQuestion,
	canonSession,
	clientMemory,
	intake,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { type Tx, withClientScope, withTx } from "../../src/db/tx";
import { connectAsApp, one, seedTenants } from "./app-role";
import {
	questionValues,
	seedCanonIdentity,
	seedSession,
	sessionValues,
	type Tenant,
} from "./canon-fixtures";
import { clock, inRollback, refusal } from "./fixtures";

// Canon's four tables (drizzle/0030_canon.sql). Run as avel_app, never
// postgres, except where a test says it is checking the owner.

const RLS_REFUSED = "42501";
const FK_REFUSED = "23503";
const CHECK_REFUSED = "23514";
const UNIQUE_REFUSED = "23505";
const APPEND_ONLY = "23001";

const TABLES = [
	"canon_message",
	"canon_question",
	"canon_session",
	"client_memory",
] as const;

function messageValues(
	t: Tenant,
	sessionId: string,
	over: Partial<typeof canonMessage.$inferInsert> = {},
): typeof canonMessage.$inferInsert {
	return {
		id: randomUUID(),
		canonSessionId: sessionId,
		clientId: t.clientId,
		seq: 1,
		role: "canon",
		mode: "draft",
		parts: [],
		contentMd: "Reading the brief.",
		citations: [],
		createdAt: clock.now(),
		...over,
	};
}

function memoryValues(
	t: Tenant,
	over: Partial<typeof clientMemory.$inferInsert> = {},
): typeof clientMemory.$inferInsert {
	return {
		id: randomUUID(),
		clientId: t.clientId,
		contentMd: "Prefers GitHub sign-in.",
		status: "proposed",
		proposedByCanonSessionId: null,
		decidedBy: null,
		decidedAt: null,
		...stamp(clock),
		...over,
	};
}

describe.skipIf(!process.env.DATABASE_URL)("Canon's tables", () => {
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

	/** Two clients, each with a session, a message, a question and a memory. */
	async function seedCanon(tx: Tx) {
		const { userId, a, b } = await seedTenants(tx, ["Meridian", "Halcyon"]);
		const identity = await seedCanonIdentity(tx);
		const rows = [];
		for (const t of [a, b]) {
			const sessionId = await seedSession(tx, t, userId, identity);
			const message = messageValues(t, sessionId);
			const question = questionValues(t, sessionId);
			const memory = memoryValues(t, { proposedByCanonSessionId: sessionId });
			await withClientScope(tx, t.scope, async (s) => {
				await s.insert(canonMessage).values(message);
				await s.insert(canonQuestion).values(question);
				await s.insert(clientMemory).values(memory);
			});
			rows.push({
				canon_session: sessionId,
				canon_message: message.id as string,
				canon_question: question.id as string,
				client_memory: memory.id as string,
			});
		}
		const [rowsA, rowsB] = rows;
		if (!rowsA || !rowsB) throw new Error("seedCanon wrote no rows");
		return { userId, identity, a, b, rowsA, rowsB };
	}

	async function ids(tx: Tx, table: (typeof TABLES)[number]) {
		const rows = await tx.execute<{ id: string }>(
			sql`select id from ${sql.identifier(table)}`,
		);
		return rows.map((r) => r.id);
	}

	describe("row-level security", () => {
		it("shows a client only its own rows in every table, and nothing unscoped", async () => {
			await asApp(async (tx) => {
				const { a, b, rowsA, rowsB } = await seedCanon(tx);
				for (const table of TABLES) {
					const seenA = await withClientScope(tx, a.scope, (s) =>
						ids(s, table),
					);
					expect(seenA, table).toContain(rowsA[table]);
					expect(seenA, table).not.toContain(rowsB[table]);
					const seenB = await withClientScope(tx, b.scope, (s) =>
						ids(s, table),
					);
					expect(seenB, table).toContain(rowsB[table]);
					expect(seenB, table).not.toContain(rowsA[table]);
					expect(await ids(tx, table), table).toEqual([]);
				}
			});
		});

		it("refuses a row for another client, and any row with no scope", async () => {
			await asApp(async (tx) => {
				const { userId, identity, a, b, rowsA, rowsB } = await seedCanon(tx);
				const writes: [string, (s: Tx) => Promise<unknown>][] = [
					[
						"canon_session",
						(s) =>
							s.insert(canonSession).values(sessionValues(b, userId, identity)),
					],
					[
						"canon_message",
						(s) =>
							s
								.insert(canonMessage)
								.values(messageValues(b, rowsB.canon_session, { seq: 2 })),
					],
					[
						"canon_question",
						(s) =>
							s
								.insert(canonQuestion)
								.values(questionValues(b, rowsB.canon_session)),
					],
					[
						"client_memory",
						(s) => s.insert(clientMemory).values(memoryValues(b)),
					],
				];
				for (const [table, write] of writes) {
					const cross = await refusal(tx, (t) =>
						withClientScope(t, a.scope, write),
					);
					expect(cross.code, table).toBe(RLS_REFUSED);
					const unscoped = await refusal(tx, write);
					expect(unscoped.code, table).toBe(RLS_REFUSED);
				}
				// Moving a row to another client is a cross-client write too.
				const moved = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s
							.update(clientMemory)
							.set({ clientId: b.clientId })
							.where(eq(clientMemory.id, rowsA.client_memory)),
					),
				);
				expect(moved.code).toBe(RLS_REFUSED);
			});
		});

		it("enables and forces it on all four, and leaves avel_app no DELETE and no message UPDATE", async () => {
			await asApp(async (tx) => {
				const rows = await tx.execute<{
					relname: string;
					enabled: boolean;
					forced: boolean;
					sel: boolean;
					ins: boolean;
					upd: boolean;
					del: boolean;
				}>(sql`
					select relname, relrowsecurity as enabled, relforcerowsecurity as forced,
						has_table_privilege('avel_app', oid, 'SELECT') as sel,
						has_table_privilege('avel_app', oid, 'INSERT') as ins,
						has_table_privilege('avel_app', oid, 'UPDATE') as upd,
						has_table_privilege('avel_app', oid, 'DELETE') as del
					from pg_class
					where relkind = 'r' and relname in ('canon_session', 'canon_message', 'canon_question', 'client_memory')
					order by relname`);
				expect(rows.map((r) => r.relname)).toEqual([...TABLES]);
				for (const r of rows) {
					expect(r, r.relname).toMatchObject({
						enabled: true,
						forced: true,
						sel: true,
						ins: true,
						upd: r.relname !== "canon_message",
						del: false,
					});
				}
			});
		});
	});

	describe("each row's client is its parent's", () => {
		it("refuses a session whose client is not its intake's", async () => {
			await asApp(async (tx) => {
				const { userId, identity, a, b } = await seedCanon(tx);
				// Closed, so the one-open-session index is not what refuses them.
				const closed = { status: "closed" as const, closedAt: clock.now() };
				// B's client on A's intake and engagement.
				const wrongClient = await refusal(tx, (t) =>
					withClientScope(t, b.scope, (s) =>
						s.insert(canonSession).values(
							sessionValues(a, userId, identity, {
								clientId: b.clientId,
								...closed,
							}),
						),
					),
				);
				expect(wrongClient.code).toBe(FK_REFUSED);
				// B's engagement and client on A's intake.
				const wrongIntake = await refusal(tx, (t) =>
					withClientScope(t, b.scope, (s) =>
						s.insert(canonSession).values(
							sessionValues(b, userId, identity, {
								intakeId: a.intakeId,
								...closed,
							}),
						),
					),
				);
				expect(wrongIntake.code).toBe(FK_REFUSED);
			});
		});

		it("refuses a message, question or memory hung off another client's session", async () => {
			await asApp(async (tx) => {
				const { a, b, rowsA } = await seedCanon(tx);
				const writes: [string, (s: Tx) => Promise<unknown>][] = [
					[
						"canon_message",
						(s) =>
							s
								.insert(canonMessage)
								.values(messageValues(b, rowsA.canon_session, { seq: 9 })),
					],
					[
						"canon_question",
						(s) =>
							s
								.insert(canonQuestion)
								.values(questionValues(b, rowsA.canon_session)),
					],
					[
						"client_memory",
						(s) =>
							s.insert(clientMemory).values(
								memoryValues(b, {
									proposedByCanonSessionId: rowsA.canon_session,
								}),
							),
					],
				];
				for (const [table, write] of writes) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, b.scope, write),
					);
					expect(err.code, table).toBe(FK_REFUSED);
				}
				// A question on one intake cannot hang off a session about another.
				const otherIntake = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s.insert(canonQuestion).values(
							questionValues(a, rowsA.canon_session, {
								intakeId: b.intakeId,
							}),
						),
					),
				);
				expect(otherIntake.code).toBe(FK_REFUSED);
			});
		});

		it("lets an intake name only a session about itself as its drafter", async () => {
			await asApp(async (tx) => {
				const { a, b, rowsA } = await seedCanon(tx);
				const err = await refusal(tx, (t) =>
					t
						.update(intake)
						.set({ draftedByCanonSessionId: rowsA.canon_session })
						.where(eq(intake.id, b.intakeId)),
				);
				expect(err.code).toBe(FK_REFUSED);
				await tx
					.update(intake)
					.set({
						draftedByCanonSessionId: rowsA.canon_session,
						recommendedRoster: {
							agents: [
								{
									agentTemplateId: randomUUID(),
									waves: ["B"],
									territory: "auth",
									writablePaths: null,
									estimatedTokens: null,
									reason: "Owns auth",
								},
							],
						},
					})
					.where(eq(intake.id, a.intakeId));
			});
		});
	});

	describe("canon_message", () => {
		it("is append-only for avel_app: no UPDATE, no DELETE", async () => {
			await asApp(async (tx) => {
				const { a, rowsA } = await seedCanon(tx);
				for (const write of [
					(s: Tx) =>
						s
							.update(canonMessage)
							.set({ contentMd: "edited" })
							.where(eq(canonMessage.id, rowsA.canon_message)),
					(s: Tx) =>
						s
							.delete(canonMessage)
							.where(eq(canonMessage.id, rowsA.canon_message)),
				]) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, write),
					);
					expect(err.code).toBe(RLS_REFUSED);
				}
			});
		});

		it("is append-only for the owner too, by trigger", async () => {
			await inRollback(async (tx) => {
				const { rowsA } = await seedCanon(tx);
				for (const statement of [
					sql`update canon_message set content_md = 'edited' where id = ${rowsA.canon_message}`,
					sql`delete from canon_message where id = ${rowsA.canon_message}`,
				]) {
					const err = await refusal(tx, (t) => t.execute(statement));
					expect(err.code).toBe(APPEND_ONLY);
				}
			});
		});

		it("orders by a seq unique per session, and an operator's message cites nothing", async () => {
			await asApp(async (tx) => {
				const { a, rowsA } = await seedCanon(tx);
				const session = rowsA.canon_session;
				const cases: [string, typeof canonMessage.$inferInsert][] = [
					[UNIQUE_REFUSED, messageValues(a, session, { seq: 1 })],
					[
						CHECK_REFUSED,
						messageValues(a, session, {
							seq: 2,
							role: "operator",
							citations: [
								{
									chunkId: `${"a".repeat(64)}:1-2`,
									heading: ["Auth"],
									quote: "x",
								},
							],
						}),
					],
					[
						CHECK_REFUSED,
						messageValues(a, session, { seq: 3, citations: {} as never }),
					],
				];
				for (const [code, values] of cases) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s.insert(canonMessage).values(values),
						),
					);
					expect(err.code).toBe(code);
				}
				await withClientScope(tx, a.scope, (s) =>
					s
						.insert(canonMessage)
						.values(messageValues(a, session, { seq: 2, role: "operator" })),
				);
			});
		});
	});

	describe("canon_question", () => {
		it("refuses fewer than two options, more than four, or options that are not a list", async () => {
			await asApp(async (tx) => {
				const { a, rowsA } = await seedCanon(tx);
				const option = { label: "x", description: "y" };
				for (const options of [
					[option],
					[option, option, option, option, option],
					{ label: "x" },
					"two",
				]) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s.insert(canonQuestion).values(
								questionValues(a, rowsA.canon_session, {
									options: options as never,
								}),
							),
						),
					);
					expect(err.code, JSON.stringify(options)).toBe(CHECK_REFUSED);
				}
			});
		});

		it("cites passages: every source chunk id is <sha256>:<first line>-<last line>", async () => {
			await asApp(async (tx) => {
				const { a, rowsA } = await seedCanon(tx);
				const sha = "a".repeat(64);
				for (const bad of [
					[`${sha.toUpperCase()}:1-2`],
					[`${sha}:0-2`],
					[`${sha}:1`],
					[`${sha}:1-02`],
					[`${sha.slice(1)}:1-2`],
					[`${sha}:1-2`, "00000000-0000-4000-8000-000000000001"],
					[`${sha}:1-2`, null],
				]) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s.insert(canonQuestion).values(
								questionValues(a, rowsA.canon_session, {
									sourceChunkIds: bad as string[],
								}),
							),
						),
					);
					expect(err.code, JSON.stringify(bad)).toBe(CHECK_REFUSED);
				}
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonQuestion).values(
						questionValues(a, rowsA.canon_session, {
							sourceChunkIds: [`${sha}:1-2`, `${"b".repeat(64)}:10-140`],
						}),
					),
				);
			});
		});

		it("refuses a header over 12 characters or blank", async () => {
			await asApp(async (tx) => {
				const { a, rowsA } = await seedCanon(tx);
				for (const header of ["Thirteen char", "   "]) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s
								.insert(canonQuestion)
								.values(questionValues(a, rowsA.canon_session, { header })),
						),
					);
					expect(err.code, header).toBe(CHECK_REFUSED);
				}
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonQuestion).values(
						questionValues(a, rowsA.canon_session, {
							header: "Twelve chars",
						}),
					),
				);
			});
		});

		it("sets decided_by and decided_at exactly when the status is not open", async () => {
			await asApp(async (tx) => {
				const { userId, a, rowsA } = await seedCanon(tx);
				const decided = { decidedBy: userId, decidedAt: clock.now() };
				const refused: Partial<typeof canonQuestion.$inferInsert>[] = [
					{ status: "answered" },
					{ status: "dismissed", decidedBy: userId },
					{ status: "acknowledged", decidedAt: clock.now() },
					{ status: "open", ...decided },
				];
				for (const over of refused) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s
								.insert(canonQuestion)
								.values(questionValues(a, rowsA.canon_session, over)),
						),
					);
					expect(err.code, JSON.stringify(over)).toBe(CHECK_REFUSED);
				}
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonQuestion).values(
						questionValues(a, rowsA.canon_session, {
							status: "answered",
							answer: { selected: ["GitHub"] },
							...decided,
						}),
					),
				);
			});
		});
	});

	describe("canon_session", () => {
		it("holds a dispatch's bounds: halt reason, close time, ceilings and token sums", async () => {
			await asApp(async (tx) => {
				const { userId, identity } = await seedCanon(tx);
				// A client with no open session, so only the CHECKs can refuse.
				const { a } = await seedTenants(tx, ["Cobalt"]);
				const refused: Partial<typeof canonSession.$inferInsert>[] = [
					{ status: "halted", closedAt: clock.now() },
					{ status: "open", haltReason: "operator" },
					{ status: "closed" },
					{ status: "open", closedAt: clock.now() },
					{ estimatedTokens: 0 },
					{ tokenSoftCeiling: 999 },
					{ tokenHardCeiling: 1499 },
					{ tokensUsed: 5, tokensIn: 4 },
					{ tokensIn: -1, tokensOut: 1 },
					{ spendUsd: "-0.01" },
					{
						status: "closed",
						closedAt: new Date(clock.now().getTime() - 1),
					},
				];
				for (const over of refused) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s
								.insert(canonSession)
								.values(sessionValues(a, userId, identity, over)),
						),
					);
					expect(err.code, JSON.stringify(over)).toBe(CHECK_REFUSED);
				}
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonSession).values(
						sessionValues(a, userId, identity, {
							status: "halted",
							haltReason: "token_hard_ceiling",
							closedAt: clock.now(),
						}),
					),
				);
			});
		});
	});

	describe("routes' columns (0039)", () => {
		const KEY_SHA = "d".repeat(64);

		it("allows one open session per intake, any number closed", async () => {
			await asApp(async (tx) => {
				const { userId, identity, a } = await seedCanon(tx);
				const second = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s.insert(canonSession).values(sessionValues(a, userId, identity)),
					),
				);
				expect(second.code).toBe(UNIQUE_REFUSED);
				expect(second.constraint_name).toBe(
					"canon_session_one_open_per_intake",
				);
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonSession).values([
						sessionValues(a, userId, identity, {
							status: "closed",
							closedAt: clock.now(),
						}),
						sessionValues(a, userId, identity, {
							status: "halted",
							haltReason: "operator",
							closedAt: clock.now(),
						}),
					]),
				);
			});
		});

		it("runs a turn only on an open session, and never halts at a spend ceiling", async () => {
			await asApp(async (tx) => {
				const { userId, identity, b } = await seedCanon(tx);
				for (const [constraint, over] of [
					[
						"canon_session_turn_only_open",
						{
							status: "closed",
							closedAt: clock.now(),
							turnStartedAt: clock.now(),
						},
					],
					[
						"canon_session_no_spend_ceiling",
						{
							status: "halted",
							haltReason: "spend_ceiling",
							closedAt: clock.now(),
						},
					],
				] as const) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, b.scope, (s) =>
							s
								.insert(canonSession)
								.values(sessionValues(b, userId, identity, over)),
						),
					);
					expect(err.constraint_name).toBe(constraint);
				}
			});
		});

		it("scopes a session's idempotency key to its intake, with its body's hash", async () => {
			await asApp(async (tx) => {
				const { userId, identity, a, b } = await seedCanon(tx);
				const keyed = (t: typeof a, over = {}) =>
					sessionValues(t, userId, identity, {
						status: "closed",
						closedAt: clock.now(),
						idempotencyKey: "k1",
						requestSha256: KEY_SHA,
						...over,
					});
				for (const [constraint, over] of [
					["canon_session_idempotency_complete", { requestSha256: null }],
					["canon_session_idempotency_complete", { idempotencyKey: null }],
					["canon_session_request_sha256_hex", { requestSha256: "x" }],
				] as const) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s.insert(canonSession).values(keyed(a, over)),
						),
					);
					expect(err.constraint_name).toBe(constraint);
				}
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonSession).values(keyed(a)),
				);
				const again = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s.insert(canonSession).values(keyed(a)),
					),
				);
				expect(again.constraint_name).toBe(
					"canon_session_intake_idempotency_key_uq",
				);
				// The same key on another intake is another request.
				await withClientScope(tx, b.scope, (s) =>
					s.insert(canonSession).values(keyed(b)),
				);
			});
		});

		it("keys only an operator's message, once per session", async () => {
			await asApp(async (tx) => {
				const { a, rowsA } = await seedCanon(tx);
				const session = rowsA.canon_session;
				const keyed = (seq: number, over = {}) =>
					messageValues(a, session, {
						seq,
						role: "operator",
						idempotencyKey: "m1",
						requestSha256: KEY_SHA,
						...over,
					});
				const canonKeyed = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s.insert(canonMessage).values(keyed(2, { role: "canon" })),
					),
				);
				expect(canonKeyed.constraint_name).toBe(
					"canon_message_key_only_operator",
				);
				const half = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s.insert(canonMessage).values(keyed(2, { requestSha256: null })),
					),
				);
				expect(half.constraint_name).toBe("canon_message_idempotency_complete");
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonMessage).values(keyed(2)),
				);
				const again = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s.insert(canonMessage).values(keyed(3)),
					),
				);
				expect(again.constraint_name).toBe(
					"canon_message_session_idempotency_key_uq",
				);
			});
		});
	});

	describe("openCanonQuestions", () => {
		it("returns the intake's open questions under its own client, oldest first", async () => {
			await asApp(async (tx) => {
				const { userId, a, rowsA } = await seedCanon(tx);
				const later = questionValues(a, rowsA.canon_session, {
					header: "Later",
					createdAt: new Date(clock.now().getTime() + 1000),
				});
				const answered = questionValues(a, rowsA.canon_session, {
					status: "answered",
					decidedBy: userId,
					decidedAt: clock.now(),
				});
				await withClientScope(tx, a.scope, (s) =>
					s.insert(canonQuestion).values([later, answered]),
				);
				const open = await openCanonQuestions(tx, a.scope, a.intakeId);
				expect(open).toEqual([
					{ id: rowsA.canon_question, header: "Auth" },
					{ id: later.id, header: "Later" },
				]);
			});
		});

		it("is what makes the read work: the same query unscoped finds nothing", async () => {
			await asApp(async (tx) => {
				const { a } = await seedCanon(tx);
				expect(await openCanonQuestions(tx, a.scope, a.intakeId)).toHaveLength(
					1,
				);
				const { count } = one(
					await tx.execute<{ count: number }>(
						sql`select count(*)::int as count from canon_question where intake_id = ${a.intakeId} and status = 'open'`,
					),
				);
				expect(count).toBe(0);
			});
		});

		it("refuses a client that is not the intake's, rather than answer none", async () => {
			await asApp(async (tx) => {
				const { a, b } = await seedCanon(tx);
				await expect(
					openCanonQuestions(tx, b.scope, a.intakeId),
				).rejects.toThrow(/not this client's/);
			});
		});
	});
});
