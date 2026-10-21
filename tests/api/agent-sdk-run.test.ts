import { createHash } from "node:crypto";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { mission } from "../../src/db/schema";
import { sequentialIds } from "../../src/lib/ids";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import {
	AgentSdkHarness,
	type QueryFn,
} from "../../src/runner/agent-sdk-harness";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { applyUsage, tick } from "../../src/runner/runner";
import { makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { captureLogger } from "../unit/support";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	queued,
	reportsOf,
	row,
	runnerDeps,
	start,
} from "./runner-fixtures";
import { clock, withApi } from "./support";

// A real AgentSdkHarness whose model is a script: it plays the agent with
// the session's own tools, so reads, writes and the report go through the
// real room and the real /api/agent/report route, in process. No network.

const base = tempDir("agent-sdk-run");
afterAll(() => removeDir(base));

const sources = path.join(base, "sources");
const clone = path.join(sources, "templates", "template-booking");
const [commit] = makeRepo(clone, {
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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!process.env.DATABASE_URL)(
	"a dispatch on the AgentSdkHarness",
	{ timeout: 30_000 },
	() => {
		afterAll(closeDb);

		it("runs the agent in its room: it reads, writes and reports through the server, and every token before the report is counted", async () => {
			const rooms = worktreeRooms(path.join(base, "rooms"));
			const { logger } = captureLogger();
			let h!: AgentSdkHarness;
			let systemAppend = "";
			const script: QueryFn = async function* (params) {
				const id = path.basename(params.options?.cwd ?? "");
				const sp = params.options?.systemPrompt;
				systemAppend =
					sp && typeof sp === "object" && "append" in sp
						? (sp.append ?? "")
						: "";
				const t = h.toolsFor(id);
				if (!t) throw new Error(`no tools for ${id}`);
				yield* message("m1", 1000, 200);
				await t.roomRead({ path: "src/a.ts" });
				yield* message("m2", 500, 100);
				await t.roomWrite({
					path: "src/b.ts",
					content: "export const b = 2;\n",
				});
				yield* message("m3", 300, 50);
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
					h.bindAgentApi(async (req) => api.app.fetch(req));
					h.bindUsageSink((id, split) => applyUsage(deps, id, split));
					const m = await activeMission(api.tx, seedIds(api.ns));
					await api.tx
						.update(mission)
						.set({ templateVersion: commit })
						.where(eq(mission.id, m.missionId));
					const id = await queued(api.tx, m);
					expect((await start(api, id)).status).toBe(200);
					await h.settled(id);
					await tick(deps);

					const d = await row(api.tx, id);
					expect(d).toMatchObject({
						status: "complete",
						model: "claude-sonnet-5-5",
						harnessVersion: "claude-agent-sdk@0.3.296",
						tokensIn: 1800,
						tokensOut: 350,
					});
					// 1800 in at $2 and 350 out at $10 per million tokens.
					expect(Number(d.spendUsd)).toBeCloseTo(0.0071, 6);
					expect(systemAppend).toContain(d.briefMd ?? "missing");
					expect(systemAppend.startsWith("#")).toBe(true);

					const [report] = await reportsOf(api.tx, id);
					expect(report).toMatchObject({
						status: "complete",
						filedBy: "agent",
						actualTokens: 2150,
						artifactsRead: [
							{ path: "src/a.ts", sha256: sha("export const a = 1;\n") },
						],
						artifactsWritten: [
							{ path: "src/b.ts", sha256: sha("export const b = 2;\n") },
						],
					});
					expect(await h.has(id)).toBe(false);
				},
				{ harness: h, rooms, roomSources: localSources(sources) },
			);
		});

		it("counts the queued message and the one still streaming when the operator halts mid-message (runner H1)", async () => {
			const rooms = worktreeRooms(path.join(base, "rooms-halt"));
			const { logger } = captureLogger();
			let streaming!: () => void;
			const midMessage = new Promise<void>((r) => {
				streaming = r;
			});
			const script: QueryFn = async function* (params) {
				const signal = params.options?.abortController?.signal;
				yield* message("m1", 1000, 200);
				yield ev({
					type: "message_start",
					message: { id: "m2", usage: { input_tokens: 500, output_tokens: 1 } },
				});
				yield ev({ type: "message_delta", usage: { output_tokens: 80 } });
				streaming();
				await new Promise<void>((resolve) =>
					signal?.addEventListener("abort", () => resolve()),
				);
				throw new Error("aborted");
			};
			const h = new AgentSdkHarness({
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
					h.bindAgentApi(async (req) => api.app.fetch(req));
					const m = await activeMission(api.tx, seedIds(api.ns));
					await api.tx
						.update(mission)
						.set({ templateVersion: commit })
						.where(eq(mission.id, m.missionId));
					const id = await queued(api.tx, m);
					expect((await start(api, id)).status).toBe(200);
					await midMessage;
					const res = await api.call(`/api/dispatches/${id}/halt`, {
						method: "POST",
					});
					expect(res.status).toBe(200);
					await h.settled(id);

					const d = await row(api.tx, id);
					expect(d).toMatchObject({
						status: "halted",
						haltReason: "operator",
						tokensIn: 1500,
						tokensOut: 280,
						tokensUsed: 1780,
					});
					// 1500 in at $2 and 280 out at $10 per million tokens.
					expect(Number(d.spendUsd)).toBeCloseTo(0.0058, 6);
					const [report] = await reportsOf(api.tx, id);
					expect(report).toMatchObject({
						filedBy: "system",
						actualTokens: 1780,
					});
					expect(await h.has(id)).toBe(false);
				},
				{ harness: h, rooms, roomSources: localSources(sources) },
			);
		});
	},
);
