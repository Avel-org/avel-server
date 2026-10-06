import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { finding, mission } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { clock, inRollback, refusal, seedMission } from "./fixtures";

const base = {
	rule: "authz.owner-check",
	subject: "PATCH /orders/:id",
	severity: "high" as const,
	class: "authorization",
	caughtBy: "security-review",
};

describe.skipIf(!process.env.DATABASE_URL)("finding", () => {
	afterAll(closeDb);

	it("refuses status=dismissed without a dismissed_reason", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			for (const dismissedReason of [null, "", "   "]) {
				const err = await refusal(tx, (t) =>
					t.insert(finding).values({
						id: ids.next(),
						missionId,
						...base,
						status: "dismissed",
						dismissedReason,
						...stamp(clock),
					}),
				);
				expect(err.constraint_name).toBe("finding_dismissed_has_reason");
			}
		});
	});

	it("refuses dismissing an existing finding without a reason", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const findingId = ids.next();
			await tx.insert(finding).values({
				id: findingId,
				missionId,
				...base,
				status: "open",
				...stamp(clock),
			});
			const err = await refusal(tx, (t) =>
				t
					.update(finding)
					.set({ status: "dismissed" })
					.where(eq(finding.id, findingId)),
			);
			expect(err.constraint_name).toBe("finding_dismissed_has_reason");
		});
	});

	it("accepts a dismissal with a reason, and open findings without one", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			await tx.insert(finding).values([
				{ id: ids.next(), missionId, ...base, status: "open", ...stamp(clock) },
				{
					id: ids.next(),
					missionId,
					...base,
					status: "dismissed",
					dismissedReason: "False positive: the guard is in middleware.",
					...stamp(clock),
				},
			]);
			const rows = await tx
				.select()
				.from(finding)
				.where(eq(finding.missionId, missionId));
			expect(rows).toHaveLength(2);
		});
	});

	it("has no deleted_at: findings are evidence", () => {
		expect("deletedAt" in finding).toBe(false);
		expect("deletedAt" in mission).toBe(true);
	});
});
