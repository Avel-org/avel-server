import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { missionSpentUsd } from "../../src/db/dispatch";
import { activityLog, mission } from "../../src/db/schema";
import { fixedClock } from "../../src/lib/clock";
import { FakeHarness } from "../../src/runner/harness";
import {
	applyUsage,
	countPending,
	inStep,
	lockDispatch,
	lockMission,
	sweep,
	tick,
} from "../../src/runner/runner";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	expectReportsMatchDispatches,
	expectSystemReport,
	pricedBook,
	queued,
	reportsOf,
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

		it("counts the queue once: the close takes it, so nothing counted is left to read", async () => {
			// A harness whose stop is slow to forget: the window between the
			// close's commit and the session's stop, held open.
			class SlowStop extends FakeHarness {
				override async stop(dispatchId: string): Promise<void> {
					this.stopped.push(dispatchId);
				}
			}
			const harness = new SlowStop();
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
					expect(await harness.next(run.id)).toBeNull();
					expect((await row(h.tx, run.id)).tokensUsed).toBe(100);
				},
				{ harness, prices },
			);
		});

		it("puts the queue back when the close rolls back", async () => {
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
						{ steps: [tokensIn(100), tokensIn(20)], outcome: "until_stopped" },
						ceilings,
					);
					const deps = runnerDeps(h, harness, prices, clock);
					class Rollback extends Error {}
					await expect(
						inStep(deps, async (step) => {
							const locked = await lockMission(step.tx, m.missionId);
							const d = await lockDispatch(step.tx, run.id);
							if (!locked || !d) throw new Error("gone");
							await countPending(step, deps, locked, d, deps.ids.next());
							throw new Rollback();
						}),
					).rejects.toBeInstanceOf(Rollback);
					expect((await row(h.tx, run.id)).tokensUsed).toBe(0);
					expect(harness.queuedUsage(run.id)).toEqual(tokensIn(120));
				},
				{ harness, prices },
			);
		});

		describe("usage counted after the close (the tick's race)", () => {
			// The tick took a usage event off the queue, and a close committed
			// before its applyUsage locked the dispatch. That usage was spent.
			async function takenThenClosed(
				h: Parameters<Parameters<typeof withApi>[0]>[0],
				harness: FakeHarness,
				ceilingUsd = "100.00",
			) {
				const m = await activeMission(h.tx, seedIds(h.ns), ceilingUsd);
				const run = await started(
					h,
					harness,
					m,
					{ steps: [tokensIn(400)], outcome: "until_stopped" },
					ceilings,
				);
				const taken = await harness.next(run.id);
				if (taken?.kind !== "usage") throw new Error("no usage queued");
				const res = await h.call(`/api/dispatches/${run.id}/halt`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				return { m, run, split: taken.split };
			}

			it("adds it to the closed dispatch and the mission's spend; the report stays as filed", async () => {
				const harness = new FakeHarness();
				const prices = pricedBook();
				await withApi(
					async (h) => {
						await h.signIn();
						const { m, run, split } = await takenThenClosed(h, harness);
						const deps = runnerDeps(h, harness, prices, clock);
						expect(await applyUsage(deps, run.id, split)).toBe(false);
						// Not expectSystemReport: the report is the snapshot at close.
						const d = await row(h.tx, run.id);
						const [r] = await reportsOf(h.tx, run.id);
						if (!r) throw new Error("no report");
						expect(d).toMatchObject({
							status: "halted",
							haltReason: "operator",
							tokensUsed: 400,
							spendUsd: "0.400000",
						});
						expect(r.actualTokens).toBe(0);
						expect(await missionSpentUsd(h.tx, m.missionId)).toBeCloseTo(
							0.4,
							6,
						);
					},
					{ harness, prices },
				);
			});

			it("logs no soft-ceiling crossing on a closed dispatch", async () => {
				const harness = new FakeHarness();
				const prices = pricedBook();
				await withApi(
					async (h) => {
						await h.signIn();
						const { run } = await takenThenClosed(h, harness);
						const deps = runnerDeps(h, harness, prices, clock);
						await applyUsage(deps, run.id, tokensIn(2000));
						expect((await row(h.tx, run.id)).tokensUsed).toBe(2000);
						const crossed = await h.tx
							.select()
							.from(activityLog)
							.where(
								and(
									eq(activityLog.entityId, run.id),
									eq(activityLog.action, "dispatch.soft_ceiling_crossed"),
								),
							);
						expect(crossed).toEqual([]);
					},
					{ harness, prices },
				);
			});

			it("halts the mission when the late count reaches its ceiling", async () => {
				const harness = new FakeHarness();
				const prices = pricedBook();
				await withApi(
					async (h) => {
						await h.signIn();
						const { m, run } = await takenThenClosed(h, harness, "1.00");
						const sibling = await started(h, harness, m, undefined, ceilings);
						const deps = runnerDeps(h, harness, prices, clock);
						expect(await applyUsage(deps, run.id, tokensIn(1000))).toBe(false);
						expect(await missionStatus(h.tx, m.missionId)).toBe("halted");
						expect((await row(h.tx, sibling.id)).haltReason).toBe(
							"spend_ceiling",
						);
						await expectReportsMatchDispatches(h.tx, [m.missionId]);
					},
					{ harness, prices },
				);
			});

			it("counts nothing on a dispatch that never started", async () => {
				const harness = new FakeHarness();
				const prices = pricedBook();
				await withApi(
					async (h) => {
						await h.signIn();
						const m = await activeMission(h.tx, seedIds(h.ns));
						const id = await queued(h.tx, m);
						const deps = runnerDeps(h, harness, prices, clock);
						expect(await applyUsage(deps, id, tokensIn(100))).toBe(false);
						expect((await row(h.tx, id)).tokensUsed).toBe(0);
					},
					{ harness, prices },
				);
			});
		});
	},
);
