import { eq } from "drizzle-orm";
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
		statusChangedAt: clock.now(),
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

	const rendered = {
		versionManifest: {},
		packageSha256: "a".repeat(64),
		packageHashVersion: 1,
	};

	it("refuses a manifest and package that are not set together", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			for (const half of [
				{ ...rendered, versionManifest: null },
				{ ...rendered, packageSha256: null },
				{ ...rendered, packageHashVersion: null },
				{ versionManifest: {} },
			]) {
				const err = await refusal(tx, (t) =>
					t
						.insert(exportTable)
						.values({ ...exportRow(ids, missionId), ...half }),
				);
				expect(err.constraint_name).toBe("export_rendered_complete");
			}
		});
	});

	it("refuses an export past rendering with no manifest, unless it failed", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			for (const status of [
				"verifying",
				"previewing",
				"previewed",
				"delivering",
				"pr-open",
				"done",
				"closed",
			] as const) {
				const err = await refusal(tx, (t) =>
					t
						.insert(exportTable)
						.values({ ...exportRow(ids, missionId), status }),
				);
				expect(err.constraint_name).toBe("export_rendered_past_rendering");
				await tx
					.insert(exportTable)
					.values({ ...exportRow(ids, missionId), status, ...rendered });
			}
			for (const status of ["pending", "rendering", "failed"] as const) {
				await tx
					.insert(exportTable)
					.values({ ...exportRow(ids, missionId), status });
			}
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
	it("refuses a status_changed_at earlier than created_at, on insert and on update", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const before = new Date(clock.now().getTime() - 1);
			const err = await refusal(tx, (t) =>
				t
					.insert(exportTable)
					.values({ ...exportRow(ids, missionId), statusChangedAt: before }),
			);
			expect(err.constraint_name).toBe("export_status_changed_after_created");

			const row = exportRow(ids, missionId);
			await tx.insert(exportTable).values(row);
			const back = await refusal(tx, (t) =>
				t
					.update(exportTable)
					// Status left alone, so only the CHECK is under test here; the
					// status-change trigger has its own tests below.
					.set({ statusChangedAt: before })
					.where(eq(exportTable.id, row.id)),
			);
			expect(back.constraint_name).toBe("export_status_changed_after_created");
		});
	});

	it("accepts a status_changed_at equal to or later than created_at", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const later = new Date(clock.now().getTime() + 60_000);
			const rows = await tx
				.insert(exportTable)
				.values([
					exportRow(ids, missionId),
					{ ...exportRow(ids, missionId), statusChangedAt: later },
				])
				.returning({ at: exportTable.statusChangedAt });
			expect(rows.map((r) => r.at)).toEqual([clock.now(), later]);
		});
	});
	describe("a status change moves status_changed_at forward", () => {
		const later = (ms: number) => new Date(clock.now().getTime() + ms);

		async function seedExport(tx: Tx, ids: IdGenerator) {
			const { missionId } = await seedMission(tx, ids);
			const row = {
				...exportRow(ids, missionId),
				statusChangedAt: later(60_000),
			};
			await tx.insert(exportTable).values(row);
			return row;
		}

		it("refuses a status change that keeps the same timestamp", async () => {
			await inRollback(async (tx, ids) => {
				const row = await seedExport(tx, ids);
				const err = await refusal(tx, (t) =>
					t
						.update(exportTable)
						.set({ status: "rendering" })
						.where(eq(exportTable.id, row.id)),
				);
				expect(err.message).toMatch(/status_changed_at/);
			});
		});

		it("refuses a status change with an earlier timestamp", async () => {
			await inRollback(async (tx, ids) => {
				const row = await seedExport(tx, ids);
				const err = await refusal(tx, (t) =>
					t
						.update(exportTable)
						.set({ status: "rendering", statusChangedAt: later(30_000) })
						.where(eq(exportTable.id, row.id)),
				);
				expect(err.message).toMatch(/status_changed_at/);
			});
		});

		it("accepts a status change with a later timestamp", async () => {
			await inRollback(async (tx, ids) => {
				const row = await seedExport(tx, ids);
				const [out] = await tx
					.update(exportTable)
					.set({ status: "rendering", statusChangedAt: later(120_000) })
					.where(eq(exportTable.id, row.id))
					.returning({ status: exportTable.status });
				expect(out?.status).toBe("rendering");
			});
		});

		it("does not constrain an update that leaves status alone", async () => {
			await inRollback(async (tx, ids) => {
				const row = await seedExport(tx, ids);
				const [out] = await tx
					.update(exportTable)
					.set({ prStatus: "open", status: "pending" })
					.where(eq(exportTable.id, row.id))
					.returning({ prStatus: exportTable.prStatus });
				expect(out?.prStatus).toBe("open");
			});
		});
	});
});
