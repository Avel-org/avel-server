import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { mission } from "../../src/db/schema";
import { randomIds } from "../../src/lib/ids";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { AgentSdkHarness } from "../../src/runner/agent-sdk-harness";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { applyUsage, tick, writeDispatchStep } from "../../src/runner/runner";
import { seedIds } from "../api/agent-fixtures";
import {
	activeMission,
	queued,
	reportsOf,
	row,
	runnerDeps,
	start,
} from "../api/runner-fixtures";
import { clock, withApi } from "../api/support";
import { makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { captureLogger } from "../unit/support";

// Step 9e: one real dispatch on the Claude Agent SDK, against the real API.
// Spends money, so it only runs with AVEL_LIVE_SMOKE=1 and a key. The
// mission lives in a rolled-back transaction; the source is a scratch repo.

const live =
	process.env.AVEL_LIVE_SMOKE === "1" && !!process.env.ANTHROPIC_API_KEY;

const PLAN = {
	summary: "A greeting helper",
	requirements: [
		{
			id: "R1",
			text: "Add src/greet.ts exporting greet(name: string): string, which returns `Hello, <name>!`",
		},
		{
			id: "R2",
			text: "Export greet from src/index.ts alongside the existing export",
		},
	],
	acceptanceCriteria: [
		{
			id: "AC1",
			requirementId: "R1",
			text: 'greet("Ada") returns "Hello, Ada!"',
		},
		{ id: "AC2", requirementId: "R2", text: "src/index.ts re-exports greet" },
	],
	modules: [
		{
			id: "M6",
			name: "Greeting",
			requirementIds: ["R1", "R2"],
			reads: ["src/**"],
		},
	],
	checks: [
		{
			id: "CK1",
			requirementId: "R1",
			kind: "test",
			command: "pnpm test greet",
		},
		{
			id: "CK2",
			requirementId: "R2",
			kind: "test",
			command: "pnpm test index",
		},
	],
};

describe.skipIf(!live || !process.env.DATABASE_URL)(
	"live smoke: one dispatch on the Claude Agent SDK",
	{ timeout: 600_000 },
	() => {
		const base = tempDir("agent-sdk-live");
		afterAll(async () => {
			await closeDb();
			// The CLI child can still hold the folder for a moment on Windows.
			try {
				removeDir(base);
			} catch (err) {
				console.log("left behind", base, String(err));
			}
		});

		it("runs, reports and is priced", async () => {
			const sources = path.join(base, "sources");
			const [commit] = makeRepo(
				path.join(sources, "templates", "template-booking"),
				{
					"src/index.ts": 'export { a } from "./a";\n',
					"src/a.ts": "export const a = 1;\n",
				},
			) as [string];
			const rooms = worktreeRooms(path.join(base, "rooms"));
			const { logger, lines } = captureLogger();
			const h = new AgentSdkHarness({
				model: "claude-sonnet-5-5",
				apiKey: process.env.ANTHROPIC_API_KEY ?? "",
				configDir: path.join(base, "config"),
				ids: randomIds,
				logger,
				clock,
				checkRunner: null,
				maxBudgetUsd: 2,
				maxTurns: 30,
				hostEnv: process.env,
			});
			await withApi(
				async (api) => {
					await api.signIn();
					const deps = runnerDeps(api, h, DEFAULT_PRICE_BOOK, clock, {
						rooms,
						roomSources: localSources(sources),
					});
					h.bindAgentApi(async (req) => api.app.fetch(req));
					h.bindUsageSink((id, split) => applyUsage(deps, id, split));
					h.bindStepSink((id, step) => writeDispatchStep(deps, id, step));
					const m = await activeMission(api.tx, seedIds(api.ns));
					await api.tx
						.update(mission)
						.set({ templateVersion: commit, brief: PLAN })
						.where(eq(mission.id, m.missionId));
					// Room for a real session: the cached system prompt alone is ~4k tokens.
					const id = await queued(api.tx, m, {
						estimatedTokens: 150_000,
						tokenSoftCeiling: 300_000,
						tokenHardCeiling: 600_000,
					});
					const t0 = Date.now();
					const res = await start(api, id);
					console.log("start", res.status, await res.clone().text());
					expect(res.status).toBe(200);
					await h.settled(id);
					await tick(deps);
					const d = await row(api.tx, id);
					const [report] = await reportsOf(api.tx, id);
					const out = {
						seconds: Math.round((Date.now() - t0) / 1000),
						status: d.status,
						model: d.model,
						harnessVersion: d.harnessVersion,
						priceVersion: d.priceVersion,
						tokensIn: d.tokensIn,
						tokensOut: d.tokensOut,
						cacheReadTokens: d.cacheReadTokens,
						cacheWriteTokens: d.cacheWriteTokens,
						spendUsd: d.spendUsd,
						report: report && {
							status: report.status,
							filedBy: report.filedBy,
							actualTokens: report.actualTokens,
							artifactsRead: report.artifactsRead,
							artifactsWritten: report.artifactsWritten,
							blockers: report.blockers,
						},
					};
					console.log("SMOKE", JSON.stringify(out, null, 2));
					console.log(
						"LOG",
						JSON.stringify(
							lines.map(
								({
									msg,
									level,
									err,
									subtype,
									num_turns,
									total_cost_usd,
									is_error,
								}) => ({
									level,
									msg,
									err,
									subtype,
									num_turns,
									total_cost_usd,
									is_error,
								}),
							),
							null,
							1,
						),
					);
				},
				{ harness: h, rooms, roomSources: localSources(sources) },
			);
		});
	},
);
