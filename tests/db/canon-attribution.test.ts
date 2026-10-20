import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { activityLog } from "../../src/db/schema";
import { type Tx, withTx } from "../../src/db/tx";
import { connectAsApp, seedTenants } from "./app-role";
import { seedCanonIdentity, seedSession } from "./canon-fixtures";
import { clock, inRollback, refusal } from "./fixtures";

// Canon's attribution in ActivityLog (drizzle/0031, 0032): actor_kind 'canon'
// names its session in actor_canon_session_id, and nothing else does.

const CHECK_REFUSED = "23514";
const PRIVILEGE_REFUSED = "42501";

function entry(over: Partial<typeof activityLog.$inferInsert>) {
	return {
		id: randomUUID(),
		at: clock.now(),
		actorKind: "system" as const,
		action: "intake.updated" as const,
		entityType: "intake" as const,
		entityId: randomUUID(),
		requestId: "req-canon",
		payload: {},
		...over,
	};
}

async function seedCanonSession(tx: Tx) {
	const { userId, a } = await seedTenants(tx, ["Meridian"]);
	const identity = await seedCanonIdentity(tx);
	const sessionId = await seedSession(tx, a, userId, identity);
	return { userId, sessionId };
}

describe.skipIf(!process.env.DATABASE_URL)("Canon in ActivityLog", () => {
	afterAll(closeDb);

	it("writes a canon row that names its session", async () => {
		await inRollback(async (tx) => {
			const { sessionId } = await seedCanonSession(tx);
			await tx
				.insert(activityLog)
				.values(entry({ actorKind: "canon", actorCanonSessionId: sessionId }));
		});
	});

	it("refuses a canon row without its session", async () => {
		await inRollback(async (tx) => {
			const err = await refusal(tx, (t) =>
				t.insert(activityLog).values(entry({ actorKind: "canon" })),
			);
			expect(err.code).toBe(CHECK_REFUSED);
			expect(err.constraint_name).toBe("activity_log_canon_has_session");
		});
	});

	it("refuses a session on any other actor's row", async () => {
		await inRollback(async (tx) => {
			const { userId, sessionId } = await seedCanonSession(tx);
			for (const over of [
				{ actorKind: "operator" as const, actorUserId: userId },
				{ actorKind: "system" as const },
			]) {
				const err = await refusal(tx, (t) =>
					t
						.insert(activityLog)
						.values(entry({ ...over, actorCanonSessionId: sessionId })),
				);
				expect(err.constraint_name, over.actorKind).toBe(
					"activity_log_canon_has_session",
				);
			}
		});
	});

	describe("as avel_app", () => {
		let app: ReturnType<typeof connectAsApp>;
		beforeAll(() => {
			app = connectAsApp();
		});
		afterAll(() => app.end());

		it("still cannot UPDATE or DELETE activity_log", async () => {
			class Rollback extends Error {}
			await withTx(app.db, async (tx) => {
				const row = entry({});
				await tx.insert(activityLog).values(row);
				for (const write of [
					(t: Tx) =>
						t
							.update(activityLog)
							.set({ requestId: "edited" })
							.where(eq(activityLog.id, row.id)),
					(t: Tx) => t.delete(activityLog).where(eq(activityLog.id, row.id)),
				]) {
					const err = await refusal(tx, write);
					expect(err.code).toBe(PRIVILEGE_REFUSED);
				}
				throw new Rollback();
			}).catch((e: unknown) => {
				if (!(e instanceof Rollback)) throw e;
			});
		});
	});
});
