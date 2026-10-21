import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { logActivity } from "../../src/db/activity";
import { closeDb, getDb } from "../../src/db/client";
import { activityLog, client } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { withTx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import { clock, inRollback, refusal } from "./fixtures";
import { errorOf, onScratchDatabase } from "./scratch";

async function createClient(tx: Tx, ids: IdGenerator, requestId: string) {
	const clientId = ids.next();
	await tx.insert(client).values({
		id: clientId,
		name: "Meridian",
		status: "active",
		...stamp(clock),
	});
	const row = await logActivity(
		tx,
		{ clock, ids },
		{
			actorKind: "system",
			action: "client.created",
			entityType: "client",
			entityId: clientId,
			requestId,
			payload: { name: "Meridian" },
		},
	);
	return { clientId, logId: row.id };
}

describe.skipIf(!process.env.DATABASE_URL)("activity_log", () => {
	afterAll(closeDb);

	it("is written with the injected clock and ids", async () => {
		await inRollback(async (tx, ids) => {
			const { logId } = await createClient(tx, ids, "req-at");
			const [row] = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.id, logId));
			expect(row?.at).toEqual(clock.now());
			expect(row?.action).toBe("client.created");
		});
	});

	it("logs a connection revocation", async () => {
		await inRollback(async (tx, ids) => {
			const row = await logActivity(
				tx,
				{ clock, ids },
				{
					actorKind: "system",
					action: "connection.revoked",
					entityType: "connection",
					entityId: ids.next(),
					requestId: "req-revoke",
					payload: { reason: "engagement closed" },
				},
			);
			const [stored] = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.id, row.id));
			expect(stored?.action).toBe("connection.revoked");
			expect(stored?.entityType).toBe("connection");
		});
	});

	it("accepts the mission and export actions the seed writes ahead of their mutations", async () => {
		await inRollback(async (tx, ids) => {
			const entries = [
				["mission.created", "mission"],
				["mission.status_changed", "mission"],
				["export.created", "export"],
				["export.status_changed", "export"],
			] as const;
			for (const [action, entityType] of entries) {
				await logActivity(
					tx,
					{ clock, ids },
					{
						actorKind: "system",
						action,
						entityType,
						entityId: ids.next(),
						requestId: "req-mission-export",
						payload: {},
					},
				);
			}
			const rows = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.requestId, "req-mission-export"));
			// No order by: the rows come back in whatever order the plan reads them.
			expect(rows.map((r) => r.action).sort()).toEqual(
				entries.map(([a]) => a).sort(),
			);
		});
	});

	it("refuses UPDATE", async () => {
		await inRollback(async (tx, ids) => {
			const { logId } = await createClient(tx, ids, "req-update");
			const err = await refusal(tx, (t) =>
				t
					.update(activityLog)
					.set({ requestId: "rewritten" })
					.where(eq(activityLog.id, logId)),
			);
			expect(err.message).toMatch(/append-only/);
		});
	});

	it("refuses DELETE", async () => {
		await inRollback(async (tx, ids) => {
			const { logId } = await createClient(tx, ids, "req-delete");
			const err = await refusal(tx, (t) =>
				t.delete(activityLog).where(eq(activityLog.id, logId)),
			);
			expect(err.message).toMatch(/append-only/);
		});
	});

	// On a database of its own: see tests/db/scratch.ts.
	it("refuses TRUNCATE", async () => {
		await onScratchDatabase("activity_truncate", async (conn) => {
			const err = await errorOf(conn`truncate activity_log`);
			expect(err?.message).toBe(
				"activity_log is append-only: TRUNCATE refused",
			);
		});
	}, 60_000);

	it("rolls back with the mutation it records", async () => {
		const requestId = "req-rollback-0001";
		class Boom extends Error {}
		await expect(
			withTx(getDb(), async (tx) => {
				await createClient(tx, sequentialFresh(), requestId);
				throw new Boom();
			}),
		).rejects.toBeInstanceOf(Boom);

		const rows = await getDb()
			.select()
			.from(activityLog)
			.where(eq(activityLog.requestId, requestId));
		expect(rows).toEqual([]);
	});

	it("requires a user for an operator and a roster entry for an agent", async () => {
		await inRollback(async (tx, ids) => {
			const base = {
				action: "client.created" as const,
				entityType: "client" as const,
				entityId: ids.next(),
				requestId: "req-actor",
				payload: {},
			};
			const operator = await refusal(tx, (t) =>
				logActivity(t, { clock, ids }, { ...base, actorKind: "operator" }),
			);
			expect(operator.constraint_name).toBe("activity_log_operator_has_user");
			const agent = await refusal(tx, (t) =>
				logActivity(t, { clock, ids }, { ...base, actorKind: "agent" }),
			);
			expect(agent.constraint_name).toBe("activity_log_agent_has_roster_entry");
		});
	});

	it("takes a transaction, never the pool", () => {
		// Type-level: if logActivity ever accepts the pool, this directive goes
		// unused and `pnpm typecheck` fails.
		const call = () =>
			// @ts-expect-error logActivity must run inside withTx
			logActivity(getDb(), { clock, ids: sequentialFresh() }, {} as never);
		expect(typeof call).toBe("function");
	});
});

// Ids that cannot collide with rows another test committed: this test commits
// nothing, but its rollback has to be observed from outside the transaction.
function sequentialFresh(): IdGenerator {
	let n = 0;
	return {
		next: () => {
			n += 1;
			return `00000000-0000-4000-8000-ac7${String(n).padStart(9, "0")}`;
		},
	};
}
