import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { runStepsEnvelope } from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { dispatchStep, mission } from "../../src/db/schema";
import { remove } from "../../src/db/schema/columns";
import { withTx } from "../../src/db/tx";
import { FakeHarness } from "../../src/runner/harness";
import { tick, writeDispatchStep } from "../../src/runner/runner";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	pricedBook,
	row,
	runnerDeps,
	started,
	tokensIn,
} from "./runner-fixtures";
import { clock, withApi } from "./support";

// A dispatch's run trace (J, 2026-10-20): the harness's step events, written
// by the runner as it reads them, read after a seq in Canon's shape.

const ceilings = {
	estimatedTokens: 1000,
	tokenSoftCeiling: 1500,
	tokenHardCeiling: 3000,
	wallClockMinutes: 60,
};

describe.skipIf(!process.env.DATABASE_URL)("dispatch steps", () => {
	afterAll(closeDb);

	it("writes each step on the tick, pairs a result with its call, and keeps counting usage", async () => {
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
						trace: [
							{ kind: "text", label: "Writing", detail: { text: "Reading." } },
							{
								kind: "tool_call",
								label: "Calling room_read",
								detail: { tool: "room_read", toolUseId: "tu_1", input: "{}" },
							},
							{
								kind: "tool_result",
								label: "room_read answered",
								detail: {
									tool: "room_read",
									toolUseId: "tu_1",
									isError: false,
									text: "ok",
								},
							},
						],
						steps: [tokensIn(100)],
						outcome: "until_stopped",
					},
					ceilings,
				);
				await tick(runnerDeps(h, harness, prices, clock));
				// The steps did not stop the tick: the usage after them counted.
				expect((await row(h.tx, run.id)).tokensUsed).toBe(100);

				const res = await h.call(`/api/dispatches/${run.id}/steps`);
				expect(res.status).toBe(200);
				const body = runStepsEnvelope.parse(await res.json());
				expect(body.meta).toEqual({ lastSeq: 3 });
				expect(body.data.map((s) => [s.seq, s.turn, s.kind])).toEqual([
					[1, null, "text"],
					[2, null, "tool_call"],
					[3, null, "tool_result"],
				]);
				expect(body.data[2]?.detail).toMatchObject({
					toolUseId: "tu_1",
					callSeq: 2,
				});
				expect(body.data[0]?.startedAt).toBe(clock.now().toISOString());

				const after = runStepsEnvelope.parse(
					await (
						await h.call(`/api/dispatches/${run.id}/steps?afterSeq=2`)
					).json(),
				);
				expect(after.data.map((s) => s.seq)).toEqual([3]);
			},
			{ harness, prices },
		);
	});

	it("numbers steps per dispatch, refuses to change one, and hides a removed mission's", async () => {
		const harness = new FakeHarness();
		const prices = pricedBook();
		await withApi(
			async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const one = await started(h, harness, m, undefined, ceilings);
				const two = await started(h, harness, m, undefined, ceilings);
				const deps = runnerDeps(h, harness, prices, clock);
				const step = {
					kind: "text" as const,
					label: "Writing",
					detail: { text: "x" },
				};
				expect(await writeDispatchStep(deps, one.id, step)).toBe(1);
				expect(await writeDispatchStep(deps, two.id, step)).toBe(1);
				expect(await writeDispatchStep(deps, one.id, step)).toBe(2);
				// A result whose call never landed names no call.
				await writeDispatchStep(deps, one.id, {
					kind: "tool_result",
					label: "x answered",
					detail: { toolUseId: "missing" },
				});
				const [orphan] = await h.tx
					.select({ detail: dispatchStep.detail })
					.from(dispatchStep)
					.where(eq(dispatchStep.seq, 3));
				expect(orphan?.detail).toMatchObject({ callSeq: null });

				// In a savepoint: the refusal would otherwise end the test's transaction.
				await expect(
					withTx(h.tx, (t) =>
						t
							.update(dispatchStep)
							.set({ label: "changed" })
							.where(eq(dispatchStep.dispatchId, one.id)),
					),
				).rejects.toMatchObject({
					cause: { message: "dispatch_step is append-only: UPDATE refused" },
				});

				await h.tx
					.update(mission)
					.set(remove(clock))
					.where(eq(mission.id, m.missionId));
				expect((await h.call(`/api/dispatches/${one.id}/steps`)).status).toBe(
					404,
				);
			},
			{ harness, prices },
		);
	});
});
