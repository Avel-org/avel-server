import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { activityLog, dispatch, mission } from "../../src/db/schema";
import { fixedClock } from "../../src/lib/clock";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { applyUsage, sweep, tick } from "../../src/runner/runner";
import { dispatchValues, insertDispatchRow } from "../db/dispatch-fixtures";
import { bearer, seedIds } from "./agent-fixtures";
import {
	activeClientMission,
	activeMission,
	expectReportsMatchDispatches,
	expectSystemReport,
	lifeOf,
	pricedBook,
	queued,
	reportsOf,
	row,
	runnerDeps,
	started,
	tokensIn,
} from "./runner-fixtures";
import { clock, withApi } from "./support";

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

async function missionStatus(tx: Parameters<typeof row>[0], missionId: string) {
	const [m] = await tx
		.select({ status: mission.status })
		.from(mission)
		.where(eq(mission.id, missionId));
	return m?.status;
}

async function statusChanges(tx: Parameters<typeof row>[0], missionId: string) {
	return tx
		.select()
		.from(activityLog)
		.where(
			and(
				eq(activityLog.entityId, missionId),
				eq(activityLog.action, "mission.status_changed"),
			),
		);
}

describe.skipIf(!process.env.DATABASE_URL)("the runner", () => {
	afterAll(closeDb);

	it("counts each usage step and prices the whole split at the frozen table", async () => {
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
					{
						steps: [
							tokensIn(100),
							{
								tokensIn: 0,
								tokensOut: 50,
								cacheReadTokens: 200,
								cacheWriteTokens: 7,
							},
						],
						outcome: "until_stopped",
					},
					ceilings,
				);
				await tick(runnerDeps(h, harness, prices, clock));
				expect(await row(h.tx, run.id)).toMatchObject({
					status: "running",
					tokensIn: 100,
					tokensOut: 50,
					cacheReadTokens: 200,
					cacheWriteTokens: 7,
					tokensUsed: 357,
					spendUsd: "0.357000",
					softCeilingCrossed: false,
				});
				// Priced at the version it froze, not the book's current one.
				const moved = pricedBook();
				moved.tables.other = {};
				moved.current = "other";
				await applyUsage(
					runnerDeps(h, harness, moved, clock),
					run.id,
					tokensIn(1),
				);
				expect((await row(h.tx, run.id)).spendUsd).toBe("0.358000");
			},
			{ harness, prices },
		);
	});

	it("records the soft-ceiling crossing once, and keeps running", async () => {
		const harness = new FakeHarness();
		const prices = pricedBook();
		await withApi(
			async (h) => {
				await h.signIn();
				// A client mission, so the crossing logs its engagement.
				const m = await activeClientMission(h, seedIds(h.ns));
				const run = await started(
					h,
					harness,
					m,
					{
						steps: [tokensIn(1000), tokensIn(500), tokensIn(100), tokensIn(10)],
						outcome: "until_stopped",
					},
					ceilings,
				);
				const deps = runnerDeps(h, harness, prices, clock);
				await tick(deps);
				await applyUsage(deps, run.id, tokensIn(1));
				const d = await row(h.tx, run.id);
				expect(d).toMatchObject({
					status: "running",
					tokensUsed: 1611,
					softCeilingCrossed: true,
				});
				const crossed = (await lifeOf(h.tx, run.id)).filter(
					(a) => a.action === "dispatch.soft_ceiling_crossed",
				);
				expect(crossed).toHaveLength(1);
				expect(crossed[0]).toMatchObject({
					actorKind: "system",
					actorUserId: null,
					actorRosterEntryId: null,
					missionId: m.missionId,
					engagementId: m.engagementId,
					payload: { tokenSoftCeiling: 1500, tokensUsed: 1500 },
				});
				expect(await reportsOf(h.tx, run.id)).toEqual([]);
			},
			{ harness, prices },
		);
	});

	it("halts at the hard ceiling (token_hard_ceiling), counts the rest of the queue (runner H1), and kills the token", async () => {
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
					{
						steps: [tokensIn(2999), tokensIn(1), tokensIn(5000)],
						outcome: "complete",
					},
					ceilings,
				);
				await tick(runnerDeps(h, harness, prices, clock));
				const { d, r } = await expectSystemReport(h.tx, run.id);
				expect(d).toMatchObject({
					status: "halted",
					haltReason: "token_hard_ceiling",
					// 3000 reached the ceiling; the 5000 still queued was spent too.
					tokensUsed: 8000,
					softCeilingCrossed: true,
				});
				expect(r).toMatchObject({ actualTokens: 8000 });
				expect(harness.stopped).toEqual([run.id]);
				await expectReportsMatchDispatches(h.tx, [m.missionId]);
				expect(await missionStatus(h.tx, m.missionId)).toBe("active");
				const life = await lifeOf(h.tx, run.id);
				expect(life.map((a) => [a.action, a.actorKind])).toEqual([
					["dispatch.started", "operator"],
					["dispatch.soft_ceiling_crossed", "system"],
					["dispatch.halted", "system"],
					["completion_report.filed", "system"],
					["dispatch.closed", "system"],
				]);
				expect(life[2]?.payload).toEqual({ reason: "token_hard_ceiling" });
				const dead = await h.call("/api/agent/dispatch", {
					headers: bearer(run.token),
				});
				expect(dead.status).toBe(401);
			},
			{ harness, prices },
		);
	});

	it("halts the mission and its running dispatches when spend reaches the ceiling", async () => {
		const harness = new FakeHarness();
		const prices = pricedBook();
		await withApi(
			async (h) => {
				await h.signIn();
				const ids = seedIds(h.ns);
				const m = await activeMission(h.tx, ids, "2.00");
				const big = { ...ceilings, tokenHardCeiling: 100_000 };
				const a = await started(
					h,
					harness,
					m,
					{ steps: [tokensIn(1200), tokensIn(300)], outcome: "until_stopped" },
					big,
				);
				const b = await started(
					h,
					harness,
					m,
					{ steps: [tokensIn(400)], outcome: "until_stopped" },
					big,
				);
				const waiting = await queued(h.tx, m);
				const other = await activeMission(h.tx, ids, "2.00");
				const elsewhere = await started(
					h,
					harness,
					other,
					{ steps: [tokensIn(100)], outcome: "until_stopped" },
					big,
				);

				// a: 1200 then 300 ($1.50); b: 400 ($1.90). Not yet.
				const deps = runnerDeps(h, harness, prices, clock);
				await tick(deps);
				expect(await missionStatus(h.tx, m.missionId)).toBe("active");
				// Exactly reaching $2.00 halts.
				expect(await applyUsage(deps, b.id, tokensIn(100))).toBe(false);

				for (const run of [a, b]) {
					const { d } = await expectSystemReport(h.tx, run.id);
					expect([d.status, d.haltReason], run.id).toEqual([
						"halted",
						"spend_ceiling",
					]);
				}
				expect((await row(h.tx, b.id)).spendUsd).toBe("0.500000");
				expect(await missionStatus(h.tx, m.missionId)).toBe("halted");
				const changes = await statusChanges(h.tx, m.missionId);
				expect(changes).toHaveLength(1);
				expect(changes[0]).toMatchObject({
					actorKind: "system",
					actorUserId: null,
					payload: { from: "active", to: "halted" },
				});
				expect(harness.stopped.sort()).toEqual([a.id, b.id].sort());
				expect((await row(h.tx, waiting)).status).toBe("queued");
				expect((await row(h.tx, elsewhere.id)).status).toBe("running");
				expect(await missionStatus(h.tx, other.missionId)).toBe("active");
				await expectReportsMatchDispatches(h.tx, [
					m.missionId,
					other.missionId,
				]);
			},
			{ harness, prices },
		);
	});

	it("keeps token_hard_ceiling on the dispatch that reached both ceilings at once", async () => {
		const harness = new FakeHarness();
		const prices = pricedBook();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns), "3.00");
				const sibling = await started(h, harness, m, undefined, ceilings);
				const run = await started(
					h,
					harness,
					m,
					{ steps: [tokensIn(3000)], outcome: "until_stopped" },
					ceilings,
				);
				await tick(runnerDeps(h, harness, prices, clock));
				expect((await row(h.tx, run.id)).haltReason).toBe("token_hard_ceiling");
				expect((await row(h.tx, sibling.id)).haltReason).toBe("spend_ceiling");
				expect(await missionStatus(h.tx, m.missionId)).toBe("halted");
				await expectSystemReport(h.tx, run.id);
				await expectSystemReport(h.tx, sibling.id);
			},
			{ harness, prices },
		);
	});

	it("halts no mission that is no longer active, even past its ceiling", async () => {
		const harness = new FakeHarness();
		const prices = pricedBook();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns), "1.00");
				const run = await started(h, harness, m, undefined, ceilings);
				await h.tx
					.update(mission)
					.set({ status: "halted" })
					.where(eq(mission.id, m.missionId));
				const deps = runnerDeps(h, harness, prices, clock);
				expect(await applyUsage(deps, run.id, tokensIn(1500))).toBe(true);
				expect(await statusChanges(h.tx, m.missionId)).toEqual([]);
				expect((await row(h.tx, run.id)).status).toBe("running");
			},
			{ harness, prices },
		);
	});

	it("closes a failed session as failed, with a system report and no halt row", async () => {
		const harness = new FakeHarness();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const run = await started(h, harness, m, {
					steps: [tokensIn(10)],
					outcome: "fail",
				});
				await tick(runnerDeps(h, harness, DEFAULT_PRICE_BOOK, clock));
				const { d, r } = await expectSystemReport(h.tx, run.id);
				expect([d.status, d.haltReason, d.tokensUsed]).toEqual([
					"failed",
					null,
					10,
				]);
				const life = await lifeOf(h.tx, run.id);
				expect(life.map((a) => [a.action, a.actorKind])).toEqual([
					["dispatch.started", "operator"],
					["completion_report.filed", "system"],
					["dispatch.closed", "system"],
				]);
				expect(life.slice(1).map((a) => a.payload)).toEqual([
					{ dispatchId: run.id, status: "failed", filedBy: "system" },
					{ status: "failed", reportId: r.id },
				]);
				expect(harness.stopped).toEqual([run.id]);
				await expectReportsMatchDispatches(h.tx, [m.missionId]);
				expect(
					(
						await h.call("/api/agent/dispatch", {
							headers: bearer(run.token),
						})
					).status,
				).toBe(401);
			},
			{ harness },
		);
	});

	for (const outcome of ["complete", "blocked"] as const) {
		it(`leaves a ${outcome} outcome to the agent's own report (step 8): still running`, async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(h, harness, m, {
						steps: [tokensIn(10)],
						outcome,
					});
					await tick(runnerDeps(h, harness, DEFAULT_PRICE_BOOK, clock));
					expect(await row(h.tx, run.id)).toMatchObject({
						status: "running",
						tokensUsed: 10,
						closedAt: null,
					});
					expect(await reportsOf(h.tx, run.id)).toEqual([]);
					expect(harness.stopped).toEqual([]);
				},
				{ harness },
			);
		});
	}

	it("sweeps: halts a run past its wall clock (wall_clock), and leaves one inside it", async () => {
		const harness = new FakeHarness();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const short = await started(h, harness, m, undefined, {
					wallClockMinutes: 60,
				});
				const long = await started(h, harness, m, undefined, {
					wallClockMinutes: 480,
				});
				const prices = DEFAULT_PRICE_BOOK;
				expect(await sweep(runnerDeps(h, harness, prices, later(59)))).toEqual({
					halted: [],
					failed: [],
				});
				expect(await tick(runnerDeps(h, harness, prices, later(60)))).toEqual({
					halted: [short.id],
					failed: [],
				});
				const { d } = await expectSystemReport(h.tx, short.id);
				expect([d.status, d.haltReason, d.closedAt]).toEqual([
					"halted",
					"wall_clock",
					later(60).now(),
				]);
				expect((await row(h.tx, long.id)).status).toBe("running");
				// FE's live finding: 9436 minutes into a 480-minute run.
				await sweep(runnerDeps(h, harness, prices, later(9436)));
				expect((await row(h.tx, long.id)).haltReason).toBe("wall_clock");
				await expectSystemReport(h.tx, long.id);
				expect(harness.stopped).toEqual([short.id, long.id]);
				await expectReportsMatchDispatches(h.tx, [m.missionId]);
			},
			{ harness },
		);
	});

	it("sweeps after a restart: no session fails a run inside its wall clock, and halts one past it", async () => {
		const harness = new FakeHarness();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const fresh = await started(h, harness, m, undefined, {
					wallClockMinutes: 120,
				});
				const stale = await started(h, harness, m, undefined, {
					wallClockMinutes: 60,
				});
				harness.restart();
				const result = await sweep(
					runnerDeps(h, harness, DEFAULT_PRICE_BOOK, later(90)),
				);
				expect(result).toEqual({ halted: [stale.id], failed: [fresh.id] });
				const failed = await expectSystemReport(h.tx, fresh.id);
				expect([failed.d.status, failed.d.haltReason]).toEqual([
					"failed",
					null,
				]);
				const halted = await expectSystemReport(h.tx, stale.id);
				expect([halted.d.status, halted.d.haltReason]).toEqual([
					"halted",
					"wall_clock",
				]);
				await expectReportsMatchDispatches(h.tx, [m.missionId]);
			},
			{ harness },
		);
	});

	it("never closes again a dispatch that stopped running between the sweep's read and its step", async () => {
		const harness = new FakeHarness();
		await withApi(
			async (h) => {
				await h.signIn();
				const ids = seedIds(h.ns);
				const m = await activeMission(h.tx, ids);
				const id = await insertDispatchRow(
					h.tx,
					ids,
					dispatchValues(m.agent, ids, "complete"),
				);
				const deps = runnerDeps(h, harness, DEFAULT_PRICE_BOOK, later(1000));
				// Usage after the close is counted (runner H1's race), but the
				// dispatch is never closed again or reported twice.
				expect(await applyUsage(deps, id, tokensIn(10))).toBe(false);
				expect((await row(h.tx, id)).tokensUsed).toBe(110);
				expect(await reportsOf(h.tx, id)).toHaveLength(0);
				expect(await sweep(deps)).toEqual({ halted: [], failed: [] });
				const [d] = await h.tx
					.select()
					.from(dispatch)
					.where(eq(dispatch.id, id));
				expect(d?.status).toBe("complete");
			},
			{ harness },
		);
	});
});
