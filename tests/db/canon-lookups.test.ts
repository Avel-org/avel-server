import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import {
	clientIdOfCanonQuestion,
	clientIdOfCanonSession,
	clientIdOfClientMemory,
} from "../../src/db/client-id";
import { canonQuestion, canonSession, clientMemory } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { type Tx, withClientScope, withTx } from "../../src/db/tx";
import { connectAsApp, one, seedTenants } from "./app-role";
import {
	questionValues,
	seedCanonIdentity,
	seedSession,
} from "./canon-fixtures";
import { clock } from "./fixtures";

// The only SECURITY DEFINER functions (drizzle/0040): each tells an id's
// client and nothing else, so an id-keyed route can set its scope. The row
// itself is still read under that scope.

const LOOKUPS = [
	"canon_session_client_id",
	"canon_question_client_id",
	"client_memory_client_id",
] as const;

describe.skipIf(!process.env.DATABASE_URL)(
	"client lookups for Canon ids",
	() => {
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

		async function seed(tx: Tx) {
			const { userId, a, b } = await seedTenants(tx, ["Meridian", "Halcyon"]);
			const identity = await seedCanonIdentity(tx);
			const sessionId = await seedSession(tx, a, userId, identity);
			const question = questionValues(a, sessionId);
			const memoryId = randomUUID();
			await withClientScope(tx, a.scope, async (s) => {
				await s.insert(canonQuestion).values(question);
				await s.insert(clientMemory).values({
					id: memoryId,
					clientId: a.clientId,
					contentMd: "Prefers GitHub sign-in.",
					status: "removed",
					proposedByCanonSessionId: null,
					decidedBy: userId,
					decidedAt: clock.now(),
					...stamp(clock),
				});
			});
			return { a, b, sessionId, questionId: question.id as string, memoryId };
		}

		it("tells an id's client with no scope set, and null for an id that does not exist", async () => {
			await asApp(async (tx) => {
				const { a, sessionId, questionId, memoryId } = await seed(tx);
				expect(await clientIdOfCanonSession(tx, sessionId)).toBe(a.clientId);
				expect(await clientIdOfCanonQuestion(tx, questionId)).toBe(a.clientId);
				// A removed memory is a status, not a deleted row: it still resolves,
				// so remove can answer 200 again and edit can say it is removed.
				expect(await clientIdOfClientMemory(tx, memoryId)).toBe(a.clientId);
				for (const lookup of [
					clientIdOfCanonSession,
					clientIdOfCanonQuestion,
					clientIdOfClientMemory,
				]) {
					expect(await lookup(tx, randomUUID())).toBeNull();
				}
				// Unscoped, the rows themselves stay out of reach.
				expect(
					await tx
						.select()
						.from(canonSession)
						.where(eq(canonSession.id, sessionId)),
				).toEqual([]);
			});
		});

		it("never returns the row under another client's scope, whatever the lookup said", async () => {
			await asApp(async (tx) => {
				const { b, sessionId, questionId, memoryId } = await seed(tx);
				await withClientScope(tx, b.scope, async (s) => {
					expect(
						await s
							.select()
							.from(canonSession)
							.where(eq(canonSession.id, sessionId)),
					).toEqual([]);
					expect(
						await s
							.select()
							.from(canonQuestion)
							.where(eq(canonQuestion.id, questionId)),
					).toEqual([]);
					expect(
						await s
							.select()
							.from(clientMemory)
							.where(eq(clientMemory.id, memoryId)),
					).toEqual([]);
				});
			});
		});

		it("is SECURITY DEFINER, STABLE, pinned, and executable by avel_app alone", async () => {
			await asApp(async (tx) => {
				const rows = await tx.execute<{
					proname: string;
					definer: boolean;
					volatile: string;
					config: string[] | null;
					byPublic: boolean;
					byApp: boolean;
				}>(sql`
				select p.proname, p.prosecdef as definer, p.provolatile as volatile,
					p.proconfig as config,
					has_function_privilege('public', p.oid, 'EXECUTE') as "byPublic",
					has_function_privilege('avel_app', p.oid, 'EXECUTE') as "byApp"
				from pg_proc p where p.proname in (${sql.join(
					LOOKUPS.map((l) => sql`${l}`),
					sql`, `,
				)}) order by p.proname`);
				expect(rows.map((r) => r.proname)).toEqual([...LOOKUPS].sort());
				for (const r of rows) {
					expect(r, r.proname).toMatchObject({
						definer: true,
						volatile: "s",
						config: ["search_path=pg_catalog, pg_temp"],
						byPublic: false,
						byApp: true,
					});
				}
				// No other SECURITY DEFINER function exists in public.
				const { count } = one(
					await tx.execute<{ count: number }>(sql`
					select count(*)::int as count from pg_proc p
					join pg_namespace n on n.oid = p.pronamespace
					where n.nspname = 'public' and p.prosecdef`),
				);
				expect(count).toBe(LOOKUPS.length);
			});
		});
	},
);
