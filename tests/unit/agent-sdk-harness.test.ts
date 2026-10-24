import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { CheckRunner } from "../../src/gateways/check-runner";
import type {
	AgentRoom,
	AgentRooms,
} from "../../src/gateways/docker-agent-rooms";
import { fixedClock } from "../../src/lib/clock";
import { sequentialIds } from "../../src/lib/ids";
import {
	AgentSdkHarness,
	AVEL_TOOL_NAMES,
	denyNonAvel,
	FIRST_MESSAGE,
	type QueryFn,
	sdkEnv,
} from "../../src/runner/agent-sdk-harness";
import {
	type AgentApi,
	type AgentCheckContext,
	agentTools,
} from "../../src/runner/agent-tools";
import type { HarnessSession } from "../../src/runner/harness";
import { removeDir, tempDir, writeFiles } from "./git-fixtures";
import { captureLogger } from "./support";

const base = tempDir("agent-sdk");
afterAll(() => removeDir(base));

let n = 0;
/** A fresh room with src/a.ts, writable under src/**. */
function room() {
	n += 1;
	const root = path.join(base, `room-${n}`);
	writeFiles(root, {
		"src/a.ts": "export const a = 1;\n",
		"README.md": "# R\n",
	});
	return { root, writableGlobs: ["src/**"] };
}

/** run_checks with no runner and no checks: the file and report tools' tests do not run checks. */
const noChecks = (): AgentCheckContext => ({
	runner: null,
	source: "",
	commit: "",
	checks: [],
	clock: fixedClock("2026-10-23T09:00:00.000Z"),
	acquire: () => () => {},
	signal: new AbortController().signal,
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** An api that records each request and answers with `status`. */
function recordingApi(status = 201, body: unknown = { success: true }) {
	const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
	const api: AgentApi = async (req) => {
		calls.push({
			url: req.url,
			headers: req.headers,
			body: await req.json(),
		});
		return new Response(JSON.stringify(body), { status });
	};
	return { api, calls };
}

function tools(over: Partial<Parameters<typeof agentTools>[0]> = {}) {
	const r = room();
	const { api, calls } = recordingApi();
	const reported: string[] = [];
	const order: string[] = [];
	const t = agentTools({
		dispatchId: "d1",
		token: "avl_dsp_secret",
		room: r,
		skills: [{ slug: "drizzle", contentMd: "# Drizzle\nUse it." }],
		api,
		ids: sequentialIds(),
		beforeReport: async () => {
			order.push("flush");
		},
		onReported: (s) => {
			order.push(`reported:${s}`);
			reported.push(s);
		},
		run: noChecks(),
		...over,
	});
	return { t, calls, reported, order, root: r.root };
}

describe("agentTools", () => {
	it("reads a file, records its path and sha, and counts a reread", async () => {
		const { t } = tools();
		expect((await t.roomRead({ path: "src/a.ts" })).text).toBe(
			"export const a = 1;\n",
		);
		await t.roomRead({ path: "./src\\a.ts" });
		await t.roomRead({ path: "README.md" });
		expect(t.artifactsRead()).toEqual([
			{ path: "src/a.ts", sha256: sha("export const a = 1;\n") },
			{ path: "README.md", sha256: sha("# R\n") },
		]);
		expect(t.rereads()).toBe(1);
	});

	it("refuses, without throwing, a path outside the room, into .git, or outside the mount", async () => {
		const { t, root } = tools();
		for (const p of ["../x", ".git/config", "C:/Windows/win.ini"]) {
			const r = await t.roomRead({ path: p });
			expect(r.isError).toBe(true);
		}
		const w = await t.roomWrite({ path: "README.md", content: "x" });
		expect(w).toMatchObject({ isError: true });
		expect(w.text).toMatch(/^outside_mount/);
		expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("# R\n");
		expect(t.artifactsRead()).toEqual([]);
	});

	it("writes, edits and lists inside the mount", async () => {
		const { t, root } = tools();
		expect((await t.roomWrite({ path: "src/b.ts", content: "b\n" })).text).toBe(
			"Wrote src/b.ts",
		);
		expect(
			(await t.roomEdit({ path: "src/a.ts", oldText: "1", newText: "2" })).text,
		).toBe("Edited src/a.ts");
		expect(readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe(
			"export const a = 2;\n",
		);
		expect((await t.roomList({})).text).toBe("README.md\nsrc/");
		expect((await t.roomList({ path: "src" })).text).toBe("a.ts\nb.ts");
	});

	it("reads only the brief's skills", async () => {
		const { t } = tools();
		expect((await t.skillRead({ slug: "drizzle" })).text).toBe(
			"# Drizzle\nUse it.",
		);
		const other = await t.skillRead({ slug: "pg" });
		expect(other.isError).toBe(true);
		expect(other.text).toContain("Yours: drizzle");
	});

	it("files the report through the agent route with the token, after flushing usage, with what was read", async () => {
		const { t, calls, order } = tools();
		await t.roomRead({ path: "src/a.ts" });
		await t.roomRead({ path: "src/a.ts" });
		const r = await t.report({ status: "complete", blockers: [] });
		expect(r.isError).toBeUndefined();
		expect(order).toEqual(["flush", "reported:complete"]);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe("http://avel.internal/api/agent/report");
		expect(call?.headers.get("authorization")).toBe("Bearer avl_dsp_secret");
		expect(call?.body).toEqual({
			status: "complete",
			artifactsRead: [
				{ path: "src/a.ts", sha256: sha("export const a = 1;\n") },
			],
			blockers: [],
			rereads: 1,
		});
		// The token is never in what the model sees.
		expect(r.text).not.toContain("secret");
		// A second report is refused without a call.
		expect((await t.report({ status: "complete", blockers: [] })).isError).toBe(
			true,
		);
		expect(calls).toHaveLength(1);
	});

	it("hands a refused report back to the agent and stays unreported", async () => {
		const { api } = recordingApi(422, {
			success: false,
			error: {
				code: "PRECONDITION_FAILED",
				message: "Writes outside the mount",
				details: { reason: "writes_outside_mount" },
			},
		});
		const { t, reported } = tools({ api });
		const r = await t.report({ status: "complete", blockers: [] });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("writes_outside_mount");
		expect(reported).toEqual([]);
	});

	it("records a finding with a fresh uuid idempotency key", async () => {
		const { t, calls } = tools();
		await t.finding({ rule: "r", subject: "s", severity: "low", class: "c" });
		expect(calls[0]?.url).toBe("http://avel.internal/api/agent/findings");
		expect(calls[0]?.headers.get("idempotency-key")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});

const session = (over: Partial<HarnessSession> = {}): HarnessSession => {
	const r = room();
	return {
		dispatchId: "00000000-0000-4000-8000-000000000001",
		token: "avl_dsp_secret",
		model: "claude-sonnet-5-5",
		roomRoot: r.root,
		writableGlobs: r.writableGlobs,
		roomRepoPath: r.root,
		roomCommit: "a".repeat(40),
		checks: [],
		identityMd: "# Kel\n\nYou are Kel.\n",
		briefMd: "# M6: Accounts\n",
		skills: [],
		...over,
	};
};

const HOST = {
	PATH: "C:\\bin",
	SystemRoot: "C:\\Windows",
	TEMP: "C:\\Temp",
	DATABASE_URL: "postgres://secret",
	AVEL_RUNNER_CREDENTIAL: "avl_run_secret",
	ANTHROPIC_API_KEY: "host-key",
	GITHUB_CLIENT_SECRET: "gh",
	USERPROFILE: "C:\\Users\\j",
};

function harness(
	query?: QueryFn,
	checks: {
		checkRunner?: CheckRunner;
		maxCheckRuns?: number;
		agentRooms?: AgentRooms;
	} = {},
) {
	const { logger, lines } = captureLogger();
	const h = new AgentSdkHarness({
		model: "claude-sonnet-5-5",
		apiKey: "sk-test",
		configDir: path.join(base, "config"),
		ids: sequentialIds(),
		logger,
		clock: fixedClock("2026-10-23T09:00:00.000Z"),
		checkRunner: checks.checkRunner ?? null,
		...(checks.agentRooms ? { agentRooms: checks.agentRooms } : {}),
		...(checks.maxCheckRuns ? { maxCheckRuns: checks.maxCheckRuns } : {}),
		maxBudgetUsd: 2,
		maxTurns: 40,
		hostEnv: HOST,
		query,
	});
	return { h, lines };
}

describe("AgentSdkHarness options", () => {
	it("gives the agent AVEL's tools only, no settings, no subagents, no prompts", () => {
		const { h } = harness();
		const s = session();
		const t = agentTools({
			dispatchId: s.dispatchId,
			token: s.token,
			room: { root: s.roomRoot, writableGlobs: [] },
			skills: [],
			api: recordingApi().api,
			ids: sequentialIds(),
			beforeReport: async () => {},
			onReported: () => {},
			run: noChecks(),
		});
		const o = h.sessionOptions(s, t, new AbortController());
		expect(o).toMatchObject({
			cwd: s.roomRoot,
			model: "claude-sonnet-5-5",
			settingSources: [],
			strictMcpConfig: true,
			tools: [],
			allowedTools: AVEL_TOOL_NAMES,
			disallowedTools: ["Agent", "Task"],
			permissionMode: "dontAsk",
			maxTurns: 40,
			maxBudgetUsd: 2,
			includePartialMessages: true,
			persistSession: false,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: "# Kel\n\nYou are Kel.\n\n# M6: Accounts\n",
			},
		});
		expect(Object.keys(o.mcpServers ?? {})).toEqual(["avel"]);
		expect(o.hooks?.PreToolUse?.[0]?.hooks).toEqual([denyNonAvel]);
		expect(AVEL_TOOL_NAMES).toEqual([
			"mcp__avel__room_read",
			"mcp__avel__room_list",
			"mcp__avel__room_write",
			"mcp__avel__room_edit",
			"mcp__avel__skill_read",
			"mcp__avel__run_checks",
			"mcp__avel__report",
			"mcp__avel__finding",
		]);
	});

	it("passes a minimal environment: never the database, the runner credential or the user's profile", () => {
		const env = sdkEnv(HOST, "sk-test", "C:\\avel\\runner-config");
		expect(env).toEqual({
			PATH: "C:\\bin",
			SystemRoot: "C:\\Windows",
			TEMP: "C:\\Temp",
			ANTHROPIC_API_KEY: "sk-test",
			HOME: "C:\\avel\\runner-config",
			USERPROFILE: "C:\\avel\\runner-config",
			CLAUDE_CONFIG_DIR: "C:\\avel\\runner-config",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
			CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
			CLAUDE_AGENT_SDK_CLIENT_APP: "avel-server",
		});
	});

	it("denies every tool but AVEL's", async () => {
		const signal = new AbortController().signal;
		const call = (tool_name: string) =>
			denyNonAvel(
				{
					hook_event_name: "PreToolUse",
					tool_name,
					tool_input: {},
					tool_use_id: "t1",
					session_id: "s",
					transcript_path: "",
					cwd: "",
				} as Parameters<typeof denyNonAvel>[0],
				"t1",
				{ signal },
			);
		expect(await call("mcp__avel__room_read")).toEqual({});
		for (const name of [
			"Bash",
			"Read",
			"Agent",
			"mcp__other__x",
			"mcp__avel__",
		]) {
			expect(await call(name)).toMatchObject({
				hookSpecificOutput: { permissionDecision: "deny" },
			});
		}
	});
});

/** A stream event message. */
const ev = (event: Record<string, unknown>) =>
	({ type: "stream_event", event }) as unknown as SDKMessage;

const resultMsg = (inputTokens: number, outputTokens: number) =>
	({
		type: "result",
		subtype: "success",
		is_error: false,
		num_turns: 1,
		total_cost_usd: 0.01,
		modelUsage: {
			"claude-sonnet-5-5": {
				inputTokens,
				outputTokens,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		},
	}) as unknown as SDKMessage;

/** One message of `input` in and `output` out, streamed. */
const message = (id: string, input: number, output: number) => [
	ev({
		type: "message_start",
		message: { id, usage: { input_tokens: input, output_tokens: 1 } },
	}),
	ev({ type: "message_delta", usage: { output_tokens: output } }),
	ev({ type: "message_stop" }),
];

async function drain(h: AgentSdkHarness, id: string) {
	const events = [];
	for (;;) {
		const e = await h.next(id);
		if (!e) return events;
		events.push(e);
	}
}

describe("AgentSdkHarness sessions", () => {
	it("creates its config folder before the SDK starts", async () => {
		const dir = path.join(base, "config");
		rmSync(dir, { recursive: true, force: true });
		let existed = false;
		const { h } = harness(async function* () {
			existed = existsSync(dir);
			yield* [];
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		await h.settled(s.dispatchId);
		expect(existed).toBe(true);
	});

	it("refuses to start with no agent api bound, or with no brief", async () => {
		const { h } = harness(async function* () {});
		expect(await h.start(session())).toBe(false);
		h.bindAgentApi(recordingApi().api);
		expect(await h.start(session({ briefMd: null }))).toBe(false);
		expect(await h.start(session())).toBe(true);
	});

	it("sends the first message, counts streamed usage, reconciles at the result, and fails a session that never reported", async () => {
		const seen: Array<{ prompt: string }> = [];
		const { h } = harness(async function* (params) {
			seen.push({ prompt: params.prompt });
			yield* message("m1", 100, 40);
			yield* message("m1", 100, 40);
			yield* message("m2", 10, 5);
			yield resultMsg(130, 45);
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		await h.settled(s.dispatchId);
		expect(seen).toEqual([{ prompt: FIRST_MESSAGE }]);
		expect(await drain(h, s.dispatchId)).toEqual([
			{
				kind: "usage",
				split: {
					tokensIn: 100,
					tokensOut: 40,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
			{
				kind: "usage",
				split: {
					tokensIn: 10,
					tokensOut: 5,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
			{
				kind: "usage",
				split: {
					tokensIn: 20,
					tokensOut: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
			{ kind: "fail" },
		]);
		expect(await h.has(s.dispatchId)).toBe(true);
	});

	it("fails a session whose query throws, and logs no token", async () => {
		const { h, lines } = harness(async function* () {
			yield* message("m1", 1, 1);
			throw new Error("401 invalid x-api-key");
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		await h.settled(s.dispatchId);
		expect((await drain(h, s.dispatchId)).at(-1)).toEqual({ kind: "fail" });
		expect(JSON.stringify(lines)).toContain("401 invalid x-api-key");
		expect(JSON.stringify(lines)).not.toContain("avl_dsp_secret");
		expect(JSON.stringify(lines)).not.toContain("sk-test");
	});

	it("reports complete, flushing queued usage to the sink before the report call, and adds no fail", async () => {
		const counted: string[] = [];
		const { api, calls } = recordingApi();
		let h!: AgentSdkHarness;
		const s = session();
		({ h } = harness(async function* () {
			yield* message("m1", 100, 40);
			await h
				.toolsFor(s.dispatchId)
				?.report({ status: "complete", blockers: [] });
			yield resultMsg(100, 40);
		}));
		h.bindAgentApi(async (req) => {
			counted.push(`report after ${counted.length} usage`);
			return api(req);
		});
		h.bindUsageSink(async (_id, split) => {
			counted.push(`usage ${split.tokensIn}`);
			return true;
		});
		await h.start(s);
		await h.settled(s.dispatchId);
		expect(counted).toEqual(["usage 100", "report after 1 usage"]);
		expect(calls).toHaveLength(1);
		expect(await drain(h, s.dispatchId)).toEqual([{ kind: "complete" }]);
	});

	it("writes its queued steps, then its usage, before the report closes the run", async () => {
		const order: string[] = [];
		const { api } = recordingApi();
		let h!: AgentSdkHarness;
		const s = session();
		({ h } = harness(async function* () {
			yield ev({
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Reporting now." },
			});
			yield ev({ type: "content_block_stop" });
			yield* message("m1", 100, 40);
			yield {
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_use",
							id: "tu_r",
							name: "mcp__avel__report",
							input: {},
						},
					],
				},
			} as unknown as SDKMessage;
			await h
				.toolsFor(s.dispatchId)
				?.report({ status: "complete", blockers: [] });
			yield resultMsg(100, 40);
		}));
		h.bindAgentApi(async (req) => {
			order.push("report");
			return api(req);
		});
		h.bindStepSink(async (_id, step) => {
			order.push(`step ${step.kind}`);
		});
		h.bindUsageSink(async (_id, split) => {
			order.push(`usage ${split.tokensIn}`);
			return true;
		});
		await h.start(s);
		await h.settled(s.dispatchId);
		// The run closes at the report, and the runner reads only running
		// dispatches: anything still queued then would never be written.
		expect(order).toEqual([
			"step text",
			"step tool_call",
			"usage 100",
			"report",
		]);
	});

	it("never launches the SDK when stopped before the query starts", async () => {
		let launched = false;
		const { h } = harness(async function* () {
			launched = true;
			yield* message("m1", 1, 1);
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		// Taken before the stop, which forgets the session.
		const done = h.settled(s.dispatchId);
		// No await between start and stop: the stop lands while the config
		// folder is still being made.
		await h.stop(s.dispatchId);
		await done;
		expect(launched).toBe(false);
		expect(await h.has(s.dispatchId)).toBe(false);
	});

	it("stops: aborts the query and forgets the session, with no fail", async () => {
		let aborted = false;
		let started: () => void = () => {};
		const running = new Promise<void>((r) => {
			started = r;
		});
		const { h } = harness(async function* (params) {
			const signal = params.options?.abortController?.signal;
			yield* message("m1", 1, 1);
			await new Promise<void>((resolve) => {
				signal?.addEventListener("abort", () => {
					aborted = true;
					resolve();
				});
				started();
			});
			throw new Error("aborted");
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		const done = h.settled(s.dispatchId);
		// Wait for the query itself, not a fixed delay: under load the config
		// folder can take longer than any delay chosen here.
		await running;
		await h.stop(s.dispatchId);
		await done;
		expect(aborted).toBe(true);
		expect(await h.has(s.dispatchId)).toBe(false);
		expect(await h.next(s.dispatchId)).toBeNull();
	});

	it("takes its queued usage and the message still streaming, counts the rest of that message at its stop, and restores what it took", async () => {
		let release!: () => void;
		const paused = new Promise<void>((r) => {
			release = r;
		});
		let reached!: () => void;
		const atPause = new Promise<void>((r) => {
			reached = r;
		});
		const { h } = harness(async function* () {
			yield* message("m1", 100, 40);
			yield ev({
				type: "message_start",
				message: { id: "m2", usage: { input_tokens: 50, output_tokens: 1 } },
			});
			yield ev({ type: "message_delta", usage: { output_tokens: 7 } });
			reached();
			await paused;
			yield ev({ type: "message_delta", usage: { output_tokens: 10 } });
			yield ev({ type: "message_stop" });
			yield resultMsg(150, 50);
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		const split = (tokensIn: number, tokensOut: number) => ({
			tokensIn,
			tokensOut,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(await h.takeUsage(s.dispatchId)).toEqual(split(0, 0));
		await h.start(s);
		await atPause;
		// m1 is queued; m2 is mid-stream at 50 in and 7 out.
		expect(await h.takeUsage(s.dispatchId)).toEqual(split(150, 47));
		expect(await h.takeUsage(s.dispatchId)).toEqual(split(0, 0));
		await h.restoreUsage(s.dispatchId, split(150, 47));
		release();
		await h.settled(s.dispatchId);
		// The restored 150 and 47, m2's last 3 out, and nothing more at the
		// result: its totals equal what was counted.
		expect(await drain(h, s.dispatchId)).toEqual([
			{ kind: "usage", split: split(150, 47) },
			{ kind: "usage", split: split(0, 3) },
			{ kind: "fail" },
		]);
	});
});

/** Agent rooms that record what the harness does with them. */
function recordingRooms(fail?: Error, closeFails?: Error) {
	const opened: Array<{ name: string; apiKey: string }> = [];
	let closes = 0;
	const room: AgentRoom = {
		spawn: () => {
			throw new Error("the scripted query never spawns");
		},
		close: async () => {
			closes += 1;
			if (closeFails) throw closeFails;
		},
		stderr: () => "docker: no such image",
	};
	const rooms: AgentRooms = {
		id: "recording",
		open: async (name, apiKey) => {
			opened.push({ name, apiKey });
			if (fail) throw fail;
			return room;
		},
		sweep: async () => {},
	};
	return { rooms, room, opened, closes: () => closes };
}

describe("AgentSdkHarness agent rooms", () => {
	it("runs the SDK's process through the session's room, opened with the key, and closes it when the session ends", async () => {
		const r = recordingRooms();
		let spawn: unknown;
		const { h, lines } = harness(
			async function* (params) {
				spawn = params.options?.spawnClaudeCodeProcess;
				yield* message("m1", 1, 1);
			},
			{ agentRooms: r.rooms },
		);
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		await h.settled(s.dispatchId);
		// A fresh name per session, so a restarted dispatch never meets the
		// old room's teardown.
		expect(r.opened.map((o) => o.apiKey)).toEqual(["sk-test"]);
		// The session's end closed its room.
		expect(r.closes()).toBe(1);
		// The room's name is logged with its dispatch, so a leftover can be traced.
		expect(lines.find((l) => l.msg === "agent room opened")).toMatchObject({
			dispatchId: s.dispatchId,
			room: r.opened[0]?.name,
		});
		// Stopped and started again, as the runner would.
		await h.stop(s.dispatchId);
		await h.start(s);
		await h.settled(s.dispatchId);
		expect(r.opened).toHaveLength(2);
		expect(r.opened[1]?.name).not.toBe(r.opened[0]?.name);
		expect(spawn).toBe(r.room.spawn);
	});

	it("survives a room whose close fails, on a stop and at the end, and logs it", async () => {
		const r = recordingRooms(undefined, new Error("spawn docker ENOENT"));
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		try {
			let started: () => void = () => {};
			const running = new Promise<void>((res) => {
				started = res;
			});
			const { h, lines } = harness(
				async function* (params) {
					const signal = params.options?.abortController?.signal;
					yield* message("m1", 1, 1);
					await new Promise<void>((resolve) => {
						signal?.addEventListener("abort", () => resolve());
						started();
					});
				},
				{ agentRooms: r.rooms },
			);
			h.bindAgentApi(recordingApi().api);
			const s = session();
			await h.start(s);
			const done = h.settled(s.dispatchId);
			await running;
			await h.stop(s.dispatchId);
			await expect(done).resolves.toBeUndefined();
			await new Promise((res) => setTimeout(res, 20));
			expect(unhandled).toEqual([]);
			expect(r.closes()).toBe(2);
			expect(lines.some((l) => l.msg === "agent room close failed")).toBe(true);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("closes the room as soon as the session is stopped, before the SDK lets go", async () => {
		const r = recordingRooms();
		let started: () => void = () => {};
		const running = new Promise<void>((res) => {
			started = res;
		});
		let closedAtAbort = -1;
		const { h } = harness(
			async function* (params) {
				const signal = params.options?.abortController?.signal;
				yield* message("m1", 1, 1);
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => {
						// Listeners run in order: the room's close was added first.
						closedAtAbort = r.closes();
						resolve();
					});
					started();
				});
				throw new Error("aborted");
			},
			{ agentRooms: r.rooms },
		);
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		const done = h.settled(s.dispatchId);
		await running;
		await h.stop(s.dispatchId);
		expect(closedAtAbort).toBe(1);
		await done;
		expect(await h.has(s.dispatchId)).toBe(false);
	});

	it("fails a session whose room cannot open, without starting the SDK, and logs docker's error", async () => {
		const r = recordingRooms(new Error("creating the key proxy failed"));
		let launched = false;
		const { h, lines } = harness(
			async function* () {
				launched = true;
				yield* [];
			},
			{ agentRooms: r.rooms },
		);
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		await h.settled(s.dispatchId);
		expect(launched).toBe(false);
		const events = await drain(h, s.dispatchId);
		expect(events.at(-1)).toEqual({ kind: "fail" });
		expect(lines.find((l) => l.msg === "agent session failed")).toMatchObject({
			err: "creating the key proxy failed",
		});
		expect(JSON.stringify(lines)).not.toContain("sk-test");
	});

	it("spawns on the host when there are no rooms", async () => {
		let options: Record<string, unknown> | undefined;
		const { h } = harness(async function* (params) {
			options = params.options as Record<string, unknown>;
			yield* [];
		});
		h.bindAgentApi(recordingApi().api);
		const s = session();
		await h.start(s);
		await h.settled(s.dispatchId);
		expect(options).toBeDefined();
		expect(options?.spawnClaudeCodeProcess).toBeUndefined();
	});
});
