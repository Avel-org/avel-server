import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { missionSpentUsd } from "../../src/db/dispatch";
import { activityLog, mission } from "../../src/db/schema";
import { fixedClock } from "../../src/lib/clock";
import { FakeHarness } from "../../src/runner/harness";
import { applyUsage, sweep, tick } from "../../src/runner/runner";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	expectReportsMatchDispatches,
	expectSystemReport,
	pricedBook,
	row,
	runnerDeps,
	started,
	tokensIn,
} from "./runner-fixtures";
import { clock, withApi } from "./support";

// Runner H1: usage the harness reported but the runner had not counted yet
// is counted in the transaction that closes the dispatch, whatever closes
// it. Each queued usage event here is tokens the model already spent. The
// hard ceiling's case is in runner.test.ts.

const MINUTE = 60_000;
const later = (minutes: number) =>
	fixedClock(new Date(clock.now().getTime() + minutes * MINUTE).toISOString());

/** Estimate 1000: soft 1500, hard 3000. At $1 per 1000 tokens. */
const ceilings = {
	estimatedTokens: 1000,
	tokenSoftCeiling: 1500,
	tokenHardCeiling: 3000,
	wallClockMinutes: 60,
};

const split = (tokensIn: number, tokensOut: number) => ({
	tokensIn,
	tokensOut,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
});

async function missionStatus(tx: Parameters<typeof row>[0], missionId: string) {
	const [m] = await tx
		.select({ status: mission.status })
		.from(mission)
		.where(eq(mission.id, missionId));
	return m?.status;
}

describe.skipIf(!process.env.DATABASE_URL)(
	"the runner, before a dispatch closes",
	() => {
		afterAll(closeDb);

		it("counts queued usage when the wall clock halts the dispatch", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(
						h,
						harness,
						m,
						{ steps: [split(400, 0), split(0, 100)], outcome: "until_stopped" },
						ceilings,
					);
					const deps = runnerDeps(h, harness, prices, later(60));
					expect(await sweep(deps)).toEqual({ halted: [run.id], failed: [] });
					const { d, r } = await expectSystemReport(h.tx, run.id);
					expect(d).toMatchObject({
						status: "halted",
						haltReason: "wall_clock",
						tokensIn: 400,
						tokensOut: 100,
						tokensUsed: 500,
						spendUsd: "0.500000",
					});
					expect(r.actualTokens).toBe(500);
					expect(await missionSpentUsd(h.tx, m.missionId)).toBeCloseTo(0.5, 6);
				},
				{ harness, prices },
			);
		});

		it("counts queued usage when the operator halts the dispatch", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(
						h,
						harness,
						m,
						{ steps: [tokensIn(250)], outcome: "until_stopped" },
						ceilings,
					);
					const res = await h.call(`/api/dispatches/${run.id}/halt`, {
						method: "POST",
					});
					expect(res.status).toBe(200);
					const { d, r } = await expectSystemReport(h.tx, run.id);
					expect([d.haltReason, d.tokensUsed, d.spendUsd]).toEqual([
						"operator",
						250,
						"0.250000",
					]);
					expect(r.actualTokens).toBe(250);
				},
				{ harness, prices },
			);
		});

		it("counts each dispatch's queued usage when the operator halts the mission", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const a = await started(
						h,
						harness,
						m,
						{ steps: [tokensIn(100)], outcome: "until_stopped" },
						ceilings,
					);
					const b = await started(
						h,
						harness,
						m,
						{ steps: [tokensIn(200), tokensIn(30)], outcome: "until_stopped" },
						ceilings,
					);
					const res = await h.call(`/api/missions/${m.missionId}/halt`, {
						method: "POST",
					});
					expect(res.status).toBe(200);
					expect((await expectSystemReport(h.tx, a.id)).r.actualTokens).toBe(
						100,
					);
					expect((await expectSystemReport(h.tx, b.id)).r.actualTokens).toBe(
						230,
					);
					expect(await missionSpentUsd(h.tx, m.missionId)).toBeCloseTo(0.33, 6);
				},
				{ harness, prices },
			);
		});

		it("counts a sibling's queued usage when the spend ceiling halts it", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns), "2.00");
					const big = { ...ceilings, tokenHardCeiling: 100_000 };
					const a = await started(h, harness, m, undefined, big);
					const b = await started(
						h,
						harness,
						m,
						{ steps: [tokensIn(300)], outcome: "until_stopped" },
						big,
					);
					const deps = runnerDeps(h, harness, prices, clock);
					expect(await applyUsage(deps, a.id, tokensIn(2000))).toBe(false);
					const sibling = await expectSystemReport(h.tx, b.id);
					expect([sibling.d.haltReason, sibling.d.tokensUsed]).toEqual([
						"spend_ceiling",
						300,
					]);
					expect(await missionSpentUsd(h.tx, m.missionId)).toBeCloseTo(2.3, 6);
					await expectReportsMatchDispatches(h.tx, [m.missionId]);
				},
				{ harness, prices },
			);
		});

		it("halts the mission at its ceiling when the counted queue reaches it", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns), "1.00");
					const run = await started(
						h,
						harness,
						m,
						{ steps: [tokensIn(1000)], outcome: "until_stopped" },
						ceilings,
					);
					const sibling = await started(h, harness, m, undefined, ceilings);
					const res = await h.call(`/api/dispatches/${run.id}/halt`, {
						method: "POST",
					});
					expect(res.status).toBe(200);
					// The operator's halt keeps its reason; the mission and the
					// sibling halt at the ceiling the counted tokens reached.
					expect((await row(h.tx, run.id)).haltReason).toBe("operator");
					expect((await row(h.tx, sibling.id)).haltReason).toBe(
						"spend_ceiling",
					);
					expect(await missionStatus(h.tx, m.missionId)).toBe("halted");
					const changes = await h.tx
						.select()
						.from(activityLog)
						.where(
							and(
								eq(activityLog.entityId, m.missionId),
								eq(activityLog.action, "mission.status_changed"),
							),
						);
					expect(changes).toHaveLength(1);
					expect(changes[0]).toMatchObject({
						actorKind: "system",
						payload: { from: "active", to: "halted" },
					});
					await expectReportsMatchDispatches(h.tx, [m.missionId]);
				},
				{ harness, prices },
			);
		});

		it("halts the mission once when a hard-ceiling close counts the queue past the spend ceiling", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns), "5.00");
					const run = await started(
						h,
						harness,
						m,
						{
							steps: [tokensIn(3000), tokensIn(3000)],
							outcome: "until_stopped",
						},
						ceilings,
					);
					await tick(runnerDeps(h, harness, prices, clock));
					expect(await row(h.tx, run.id)).toMatchObject({
						haltReason: "token_hard_ceiling",
						tokensUsed: 6000,
					});
					expect(await missionStatus(h.tx, m.missionId)).toBe("halted");
					const changes = await h.tx
						.select()
						.from(activityLog)
						.where(
							and(
								eq(activityLog.entityId, m.missionId),
								eq(activityLog.action, "mission.status_changed"),
							),
						);
					expect(changes).toHaveLength(1);
				},
				{ harness, prices },
			);
		});

		it("counts nothing twice: a close that counted the queue leaves the runner nothing to add", async () => {
			const harness = new FakeHarness();
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(
						h,
						harness,
						m,
						{ steps: [tokensIn(100)], outcome: "until_stopped" },
						ceilings,
					);
					const deps = runnerDeps(h, harness, prices, later(60));
					await sweep(deps);
					await tick(deps);
					expect(await applyUsage(deps, run.id, tokensIn(100))).toBe(false);
					expect((await row(h.tx, run.id)).tokensUsed).toBe(100);
				},
				{ harness, prices },
			);
		});
	},
);
