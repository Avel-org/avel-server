import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { exportTable, user } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import { clock, inRollback, refusal, seedMission } from "./fixtures";

async function seedOperator(tx: Tx, ids: IdGenerator) {
	const userId = ids.next();
	await tx.insert(user).values({
		id: userId,
		name: "Operator",
		email: "operator@example.com",
		emailVerified: true,
		githubId: "1",
		githubLogin: "operator",
		...stamp(clock),
	});
	return userId;
}

function exportRow(ids: IdGenerator, missionId: string) {
	return {
		id: ids.next(),
		missionId,
		sprintN: 1,
		idempotencyKey: `export-${ids.next()}`,
		targetKind: "zip" as const,
		status: "pending" as const,
		...stamp(clock),
	};
}

describe.skipIf(!process.env.DATABASE_URL)("export", () => {
	afterAll(closeDb);

	it("refuses a half-filled gate override", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const userId = await seedOperator(tx, ids);
			const full = {
				gateOverrideGate: "qa" as const,
				gateOverrideJustification: "Flaky test quarantined; tracked.",
				gateOverrideBy: userId,
				gateOverrideAt: clock.now(),
			};
			const halves = [
				{ ...full, gateOverrideGate: null },
				{ ...full, gateOverrideJustification: null },
				{ ...full, gateOverrideJustification: "   " },
				{ ...full, gateOverrideBy: null },
				{ ...full, gateOverrideAt: null },
				{ gateOverrideGate: "qa" as const },
			];
			for (const half of halves) {
				const err = await refusal(tx, (t) =>
					t
						.insert(exportTable)
						.values({ ...exportRow(ids, missionId), ...half }),
				);
				expect(err.constraint_name).toBe("export_gate_override_complete");
			}
		});
	});

	it("accepts no override, and a complete one", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const userId = await seedOperator(tx, ids);
			const rows = await tx
				.insert(exportTable)
				.values([
					exportRow(ids, missionId),
					{
						...exportRow(ids, missionId),
						gateOverrideGate: "qa",
						gateOverrideJustification: "Flaky test quarantined; tracked.",
						gateOverrideBy: userId,
						gateOverrideAt: clock.now(),
					},
				])
				.returning({ by: exportTable.gateOverrideBy });
			expect(rows.map((r) => r.by)).toEqual([null, userId]);
		});
	});

	it("refuses an override by a user that does not exist", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const err = await refusal(tx, (t) =>
				t.insert(exportTable).values({
					...exportRow(ids, missionId),
					gateOverrideGate: "qa",
					gateOverrideJustification: "No such operator.",
					gateOverrideBy: ids.next(),
					gateOverrideAt: clock.now(),
				}),
			);
			expect(err.constraint_name).toBe("export_gate_override_by_user_id_fk");
		});
	});

	it("refuses a non-zip export without a connection", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			for (const targetKind of ["github_pr", "github_push"] as const) {
				const err = await refusal(tx, (t) =>
					t
						.insert(exportTable)
						.values({ ...exportRow(ids, missionId), targetKind }),
				);
				expect(err.constraint_name).toBe("export_connection_unless_zip");
			}
		});
	});
});
