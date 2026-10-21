import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "../../src/db/client";
import { dispatchStep, mission } from "../../src/db/schema";
import { fixedClock } from "../../src/lib/clock";
import { sequentialIds } from "../../src/lib/ids";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import {
	AgentSdkHarness,
	type QueryFn,
} from "../../src/runner/agent-sdk-harness";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { startRunnerLoop } from "../../src/runner/loop";
import { startRealRunner } from "../../src/runner/wiring";
import { makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { captureLogger } from "../unit/support";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	expectSystemReport,
	queued,
	reportsOf,
	row,
	runnerDeps,
	start,
	started,
	tokensIn,
} from "./runner-fixtures";
import { clock, withApi } from "./support";

// The runner's loop with its real sweep and tick, and the server's wiring
// of the real harness (src/runner/wiring.ts), against the database.

const MINUTE = 60_000;
const later = (minutes: number) =>
	fixedClock(new Date(clock.now().getTime() + minutes * MINUTE).toISOString());

const base = tempDir("runner-loop");
afterAll(() => removeDir(base));
const sources = path.join(base, "sources");
const [commit] = makeRepo(path.join(sources, "templates", "template-booking"), {
	"src/a.ts": "export const a = 1;\n",
}) as [string];

const ev = (event: Record<string, unknown>) =>
	({ type: "stream_event", event }) as unknown as SDKMessage;

const message = (id: string, input: number, output: number) => [
	ev({
		type: "message_start",
		message: { id, usage: { input_tokens: input, output_tokens: 1 } },
	}),
	ev({ type: "message_delta", usage: { output_tokens: output } }),
	ev({ type: "message_stop" }),
];

describe.skipIf(!process.env.DATABASE_URL)(
	"the runner's loop",
	{ timeout: 30_000 },
	() => {
		afterAll(closeDb);

		it("sweeps at startup: halts a run past its wall clock and fails one with no session, before any tick", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const over = await started(h, harness, m, undefined, {
						wallClockMinutes: 60,
					});
					const inside = await started(h, harness, m, undefined, {
						wallClockMinutes: 480,
					});
					const orphan = await started(h, harness, m, undefined, {
						wallClockMinutes: 480,
					});
					await harness.stop(orphan.id);
					const { logger, lines } = captureLogger();
					// An interval no test waits out: only the startup sweep runs.
					const stop = startRunnerLoop(
						runnerDeps(h, harness, DEFAULT_PRICE_BOOK, later(61)),
						{ intervalMs: 3_600_000, logger },
					);
					await stop();
					const halted = await expectSystemReport(h.tx, over.id);
					expect([halted.d.status, halted.d.haltReason]).toEqual([
						"halted",
						"wall_clock",
					]);
					const failed = await expectSystemReport(h.tx, orphan.id);
					expect(failed.d.status).toBe("failed");
					expect((await row(h.tx, inside.id)).status).toBe("running");
					expect(
						lines.find((l) => l.msg === "runner closed dispatches"),
					).toMatchObject({ halted: [over.id], failed: [orphan.id] });
				},
				{ harness },
			);
		});

		it("ticks: counts a session's usage, and closes it at its hard ceiling, until stopped", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(
						h,
						harness,
						m,
						{
							steps: [tokensIn(1000), tokensIn(2000)],
							outcome: "until_stopped",
						},
						{
							estimatedTokens: 1000,
							tokenSoftCeiling: 1500,
							tokenHardCeiling: 3000,
						},
					);
					const { logger } = captureLogger();
					const stop = startRunnerLoop(
						runnerDeps(h, harness, DEFAULT_PRICE_BOOK, clock),
						{ intervalMs: 20, logger },
					);
					try {
						await vi.waitFor(
							async () =>
								expect((await row(h.tx, run.id)).status).toBe("halted"),
							{ timeout: 10_000, interval: 25 },
						);
					} finally {
						await stop();
					}
					const { d } = await expectSystemReport(h.tx, run.id);
					expect([d.haltReason, d.tokensUsed]).toEqual([
						"token_hard_ceiling",
						3000,
					]);
					expect(harness.stopped).toEqual([run.id]);
				},
				{ harness },
			);
		});

		it("wires the real harness: its report goes through the app, its usage and steps to the runner, and the loop ticks the rest", async () => {
			const rooms = worktreeRooms(path.join(base, "rooms"));
			const { logger } = captureLogger();
			let h!: AgentSdkHarness;
			const script: QueryFn = async function* (params) {
				const id = path.basename(params.options?.cwd ?? "");
				const t = h.toolsFor(id);
				if (!t) throw new Error(`no tools for ${id}`);
				yield ev({
					type: "content_block_delta",
					delta: { type: "text_delta", text: "Reading a.ts." },
				});
				yield ev({ type: "content_block_stop" });
				yield* message("m1", 1000, 200);
				await t.roomRead({ path: "src/a.ts" });
				yield* message("m2", 300, 50);
				await t.report({ status: "complete", blockers: [] });
			};
			h = new AgentSdkHarness({
				model: "claude-sonnet-5-5",
				apiKey: "sk-test",
				configDir: path.join(base, "config"),
				ids: sequentialIds(),
				logger,
				maxBudgetUsd: 2,
				maxTurns: 40,
				hostEnv: {},
				query: script,
			});
			await withApi(
				async (api) => {
					await api.signIn();
					const deps = runnerDeps(api, h, DEFAULT_PRICE_BOOK, clock, {
						rooms,
						roomSources: localSources(sources),
					});
					const stop = startRealRunner(h, api.app.fetch, deps, {
						intervalMs: 3_600_000,
						logger,
					});
					try {
						const m = await activeMission(api.tx, seedIds(api.ns));
						await api.tx
							.update(mission)
							.set({ templateVersion: commit })
							.where(eq(mission.id, m.missionId));
						const id = await queued(api.tx, m);
						expect((await start(api, id)).status).toBe(200);
						await h.settled(id);

						const d = await row(api.tx, id);
						expect(d).toMatchObject({
							status: "complete",
							tokensIn: 1300,
							tokensOut: 250,
						});
						const [report] = await reportsOf(api.tx, id);
						expect(report).toMatchObject({
							filedBy: "agent",
							actualTokens: 1550,
						});
						const steps = await api.tx
							.select({ kind: dispatchStep.kind })
							.from(dispatchStep)
							.where(eq(dispatchStep.dispatchId, id));
						expect(steps.map((s) => s.kind)).toContain("text");
					} finally {
						await stop();
					}
				},
				{ harness: h, rooms, roomSources: localSources(sources) },
			);
		});

		it("wires the real harness's usage to the runner: the usage before a report halts at the hard ceiling, so the report finds the dispatch closed", async () => {
			const rooms = worktreeRooms(path.join(base, "rooms-ceiling"));
			const { logger } = captureLogger();
			let h!: AgentSdkHarness;
			let answer = "";
			const script: QueryFn = async function* (params) {
				const id = path.basename(params.options?.cwd ?? "");
				const t = h.toolsFor(id);
				if (!t) throw new Error(`no tools for ${id}`);
				yield* message("m1", 1000, 200);
				answer = (await t.report({ status: "complete", blockers: [] })).text;
			};
			h = new AgentSdkHarness({
				model: "claude-sonnet-5-5",
				apiKey: "sk-test",
				configDir: path.join(base, "config"),
				ids: sequentialIds(),
				logger,
				maxBudgetUsd: 2,
				maxTurns: 40,
				hostEnv: {},
				query: script,
			});
			await withApi(
				async (api) => {
					await api.signIn();
					const deps = runnerDeps(api, h, DEFAULT_PRICE_BOOK, clock, {
						rooms,
						roomSources: localSources(sources),
					});
					const stop = startRealRunner(h, api.app.fetch, deps, {
						intervalMs: 3_600_000,
						logger,
					});
					try {
						const m = await activeMission(api.tx, seedIds(api.ns));
						await api.tx
							.update(mission)
							.set({ templateVersion: commit })
							.where(eq(mission.id, m.missionId));
						const id = await queued(api.tx, m, {
							estimatedTokens: 500,
							tokenSoftCeiling: 800,
							tokenHardCeiling: 1000,
						});
						expect((await start(api, id)).status).toBe(200);
						await h.settled(id);
						const { d } = await expectSystemReport(api.tx, id);
						expect([d.haltReason, d.tokensUsed]).toEqual([
							"token_hard_ceiling",
							1200,
						]);
						expect(answer).not.toBe("");
					} finally {
						await stop();
					}
				},
				{ harness: h, rooms, roomSources: localSources(sources) },
			);
		});
	},
);
