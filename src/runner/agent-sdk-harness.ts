import {
	createSdkMcpServer,
	type HookCallback,
	type Options,
	type SDKMessage,
	query as sdkQuery,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IdGenerator } from "../lib/ids";
import type { Logger } from "../lib/logger";
import {
	type AgentApi,
	type AgentTools,
	agentTools,
	type ToolResult,
} from "./agent-tools";
import type {
	Harness,
	HarnessEvent,
	HarnessSession,
	HarnessStep,
} from "./harness";
import { SdkStepTrace } from "./sdk-steps";
import {
	type ResultModelUsage,
	UsageCounter,
	type UsageStreamEvent,
} from "./sdk-usage";

/**
 * The real harness (step 9d; docs/STEP-9-PLAN.md, The harness): one Claude
 * Agent SDK query per dispatch, in this process. The agent gets AVEL's
 * tools and nothing else: no built-in tool, no filesystem settings, no
 * CLAUDE.md, no other MCP server, no subagents, and an environment with no
 * database URL and no runner credential. A PreToolUse hook denies any tool
 * not AVEL's, behind the empty tool list.
 *
 * The runner still holds the budget: this harness only reports usage, and
 * the runner counts it, prices it and stops the session. maxBudgetUsd and
 * maxTurns are backstops in case the runner is not ticking.
 *
 * Not built: D1's fallback to the Claude Code CLI. A session that cannot
 * run reports fail, and the runner closes the dispatch failed with its
 * system report.
 */

/** The SDK version this harness was built and checked against. */
export const AGENT_SDK_VERSION = "0.3.296";

const SERVER = "avel";

/** The tool names the agent may call, as the SDK prefixes them. */
export const AVEL_TOOL_NAMES = [
	"room_read",
	"room_list",
	"room_write",
	"room_edit",
	"skill_read",
	"report",
	"finding",
].map((t) => `mcp__${SERVER}__${t}`);

/** The first user message. The brief, in the system prompt, says the rest. */
export const FIRST_MESSAGE =
	"Do the module in your brief. You are done when every check under Done when would pass; the checks run outside you. Read the files under Read before you change anything. File your report with the report tool when you finish or are blocked, then stop.";

export type QueryFn = (params: {
	prompt: string;
	options?: Options;
}) => AsyncIterable<SDKMessage>;

export type AgentSdkHarnessOptions = {
	model: string;
	apiKey: string;
	/** A directory of this runner's own: CLAUDE_CONFIG_DIR and HOME for the SDK. */
	configDir: string;
	ids: IdGenerator;
	logger: Logger;
	/** Backstop on the SDK's own cost estimate, per dispatch. */
	maxBudgetUsd: number;
	maxTurns: number;
	/** The SDK's query; tests pass a scripted one. */
	query?: QueryFn;
	/** The host environment the minimal one is picked from. */
	hostEnv?: NodeJS.ProcessEnv;
};

/** Counts one usage split on a running dispatch; false once it is no longer running. */
export type UsageSink = (
	dispatchId: string,
	split: import("../lib/prices").TokenSplit,
) => Promise<boolean>;

/** The runner's writeDispatchStep, for the steps queued when a report closes the run. */
export type StepSink = (
	dispatchId: string,
	step: HarnessStep,
) => Promise<unknown>;

type Running = {
	abort: AbortController;
	events: HarnessEvent[];
	tools: AgentTools;
	reported: boolean;
	done: Promise<void>;
};

/** Denies every tool but AVEL's: the hook runs before any permission rule. */
export const denyNonAvel: HookCallback = async (input) => {
	const name = "tool_name" in input ? String(input.tool_name) : "";
	if (AVEL_TOOL_NAMES.includes(name)) return {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `${name} is not one of this agent's tools`,
		},
	};
};

/**
 * The environment the SDK's process gets. `env` replaces process.env, so
 * only what it needs to start is copied: the path, the Windows basics, the
 * API key and the isolation flags. HOME and CLAUDE_CONFIG_DIR point at the
 * runner's own directory, so no user setting, memory or CLAUDE.md loads.
 */
export function sdkEnv(
	host: NodeJS.ProcessEnv,
	apiKey: string,
	configDir: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of [
		"PATH",
		"Path",
		"PATHEXT",
		"SystemRoot",
		"SYSTEMROOT",
		"TEMP",
		"TMP",
		"ComSpec",
	]) {
		const v = host[name];
		if (v) env[name] = v;
	}
	return {
		...env,
		ANTHROPIC_API_KEY: apiKey,
		HOME: configDir,
		USERPROFILE: configDir,
		CLAUDE_CONFIG_DIR: configDir,
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
		CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
		CLAUDE_AGENT_SDK_CLIENT_APP: "avel-server",
	};
}

function result(r: ToolResult) {
	return {
		content: [{ type: "text" as const, text: r.text }],
		...(r.isError ? { isError: true } : {}),
	};
}

const blockerShape = z.object({
	description: z.string().min(1),
	workaround: z.string(),
	provisioningGap: z.boolean(),
});

/** The in-process MCP server over one session's tools. */
function avelServer(t: AgentTools) {
	return createSdkMcpServer({
		name: SERVER,
		version: "1",
		tools: [
			tool(
				"room_read",
				"Read a file in the room, by its path from the room root.",
				{ path: z.string() },
				async (a) => result(await t.roomRead(a)),
			),
			tool(
				"room_list",
				"List a directory in the room. Directories end with /.",
				{ path: z.string().optional() },
				async (a) => result(await t.roomList(a)),
			),
			tool(
				"room_write",
				"Write a whole file in the room. Only paths your mount allows.",
				{ path: z.string(), content: z.string() },
				async (a) => result(await t.roomWrite(a)),
			),
			tool(
				"room_edit",
				"Replace exactly one occurrence of oldText with newText in a file.",
				{ path: z.string(), oldText: z.string(), newText: z.string() },
				async (a) => result(await t.roomEdit(a)),
			),
			tool(
				"skill_read",
				"Read one of your brief's skills in full, by its slug.",
				{ slug: z.string() },
				async (a) => result(await t.skillRead(a)),
			),
			tool(
				"report",
				"File your completion report: complete with no blockers, or blocked with at least one. What you read is recorded for you. This ends your dispatch.",
				{
					status: z.enum(["complete", "blocked"]),
					blockers: z.array(blockerShape),
				},
				async (a) => result(await t.report(a)),
			),
			tool(
				"finding",
				"Record a defect on the mission. Review agents only.",
				{
					rule: z.string().min(1),
					subject: z.string().min(1),
					severity: z.enum(["critical", "high", "medium", "low"]),
					class: z.string().min(1),
				},
				async (a) => result(await t.finding(a)),
			),
		],
	});
}

export class AgentSdkHarness implements Harness {
	readonly model: string;
	readonly version = `claude-agent-sdk@${AGENT_SDK_VERSION}`;
	private readonly options: AgentSdkHarnessOptions;
	private readonly query: QueryFn;
	private readonly sessions = new Map<string, Running>();
	private api: AgentApi | null = null;
	private countUsage: UsageSink | null = null;
	private writeStep: StepSink | null = null;

	constructor(options: AgentSdkHarnessOptions) {
		this.options = options;
		this.model = options.model;
		this.query = options.query ?? (sdkQuery as QueryFn);
	}

	/** The app's fetch, bound once the app exists: report and finding call it. */
	bindAgentApi(api: AgentApi): void {
		this.api = api;
	}

	/**
	 * The runner's applyUsage, bound with the runner's deps. The report tool
	 * uses it to count every queued usage event before the report closes
	 * the dispatch; ticks count the rest.
	 */
	bindUsageSink(sink: UsageSink): void {
		this.countUsage = sink;
	}

	/**
	 * The runner's writeDispatchStep, bound with the runner's deps. The
	 * report closes the dispatch, and the runner reads only running ones, so
	 * the report tool writes every queued step first; ticks write the rest.
	 */
	bindStepSink(sink: StepSink): void {
		this.writeStep = sink;
	}

	/** Writes the session's queued steps now, in order; other events stay queued. */
	private async flushSteps(dispatchId: string, events: HarnessEvent[]) {
		const sink = this.writeStep;
		if (!sink) return;
		for (;;) {
			const i = events.findIndex((e) => e.kind === "step");
			if (i < 0) return;
			const [e] = events.splice(i, 1);
			if (e?.kind === "step") await sink(dispatchId, e.step);
		}
	}

	/** Counts the session's queued usage events now, in order; other events stay queued. */
	private async flushUsage(dispatchId: string, events: HarnessEvent[]) {
		const sink = this.countUsage;
		if (!sink) return;
		for (;;) {
			const i = events.findIndex((e) => e.kind === "usage");
			if (i < 0) return;
			const [e] = events.splice(i, 1);
			if (e?.kind === "usage" && !(await sink(dispatchId, e.split))) return;
		}
	}

	/** The session's tools, for tests that play the agent. */
	toolsFor(dispatchId: string): AgentTools | undefined {
		return this.sessions.get(dispatchId)?.tools;
	}

	/** The SDK options for one session. Exported shape, for tests. */
	sessionOptions(
		session: HarnessSession,
		tools: AgentTools,
		abort: AbortController,
	): Options {
		const o = this.options;
		return {
			cwd: session.roomRoot,
			model: session.model,
			settingSources: [],
			strictMcpConfig: true,
			tools: [],
			mcpServers: { [SERVER]: avelServer(tools) },
			allowedTools: [...AVEL_TOOL_NAMES],
			disallowedTools: ["Agent", "Task"],
			permissionMode: "dontAsk",
			hooks: { PreToolUse: [{ hooks: [denyNonAvel] }] },
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: `${session.identityMd.trimEnd()}\n\n${session.briefMd ?? ""}`,
			},
			maxTurns: o.maxTurns,
			maxBudgetUsd: o.maxBudgetUsd,
			abortController: abort,
			env: sdkEnv(o.hostEnv ?? process.env, o.apiKey, o.configDir),
			includePartialMessages: true,
			persistSession: false,
		};
	}

	async start(session: HarnessSession): Promise<boolean> {
		// A real agent works from a brief; a dispatch with none cannot run here.
		if (!this.api || session.briefMd === null) return false;
		if (this.sessions.has(session.dispatchId)) return false;
		const abort = new AbortController();
		const events: HarnessEvent[] = [];
		const running: Running = {
			abort,
			events,
			reported: false,
			tools: agentTools({
				dispatchId: session.dispatchId,
				token: session.token,
				room: { root: session.roomRoot, writableGlobs: session.writableGlobs },
				skills: session.skills,
				api: this.api,
				ids: this.options.ids,
				beforeReport: async () => {
					await this.flushSteps(session.dispatchId, events);
					await this.flushUsage(session.dispatchId, events);
				},
				onReported: (status) => {
					running.reported = true;
					events.push({ kind: status });
				},
			}),
			done: Promise.resolve(),
		};
		this.sessions.set(session.dispatchId, running);
		running.done = this.run(session, running);
		return true;
	}

	/** Reads the session's messages until it ends, turning them into events. */
	private async run(session: HarnessSession, r: Running): Promise<void> {
		const log = this.options.logger.child({ dispatchId: session.dispatchId });
		const usage = new UsageCounter();
		const trace = new SdkStepTrace();
		const steps = (list: HarnessStep[]) => {
			for (const step of list) r.events.push({ kind: "step", step });
		};
		try {
			const messages = this.query({
				prompt: FIRST_MESSAGE,
				options: this.sessionOptions(session, r.tools, r.abort),
			});
			for await (const m of messages) {
				if (r.abort.signal.aborted) return;
				steps(trace.onMessage(m));
				if (m.type === "stream_event") {
					const split = usage.onEvent(m.event as UsageStreamEvent);
					if (split) r.events.push({ kind: "usage", split });
				} else if (m.type === "system" && m.subtype === "init") {
					log.info(
						{ model: m.model, apiKeySource: m.apiKeySource, tools: m.tools },
						"agent session started",
					);
				} else if (m.type === "result") {
					const rest = usage.onResult(m.modelUsage as ResultModelUsage);
					if (rest) r.events.push({ kind: "usage", split: rest });
					log.info(
						{
							subtype: m.subtype,
							isError: m.is_error,
							turns: m.num_turns,
							sdkCostUsd: m.total_cost_usd,
						},
						"agent session ended",
					);
				}
			}
			steps(trace.flush());
			// The session ended. Without a report, its work stopped with
			// nothing to say, which the runner records as failed.
			if (!r.reported && !r.abort.signal.aborted)
				r.events.push({ kind: "fail" });
		} catch (err) {
			if (r.abort.signal.aborted) return;
			log.error(
				{ err: err instanceof Error ? err.message : String(err) },
				"agent session failed",
			);
			steps([
				...trace.flush(),
				trace.error(err instanceof Error ? err.message : String(err)),
			]);
			if (!r.reported) r.events.push({ kind: "fail" });
		}
	}

	async has(dispatchId: string): Promise<boolean> {
		return this.sessions.has(dispatchId);
	}

	async next(dispatchId: string): Promise<HarnessEvent | null> {
		return this.sessions.get(dispatchId)?.events.shift() ?? null;
	}

	async stop(dispatchId: string): Promise<void> {
		const r = this.sessions.get(dispatchId);
		if (!r) return;
		this.sessions.delete(dispatchId);
		r.abort.abort();
	}

	/** Resolves when the session's message loop has ended. Tests wait on it. */
	settled(dispatchId: string): Promise<void> {
		return this.sessions.get(dispatchId)?.done ?? Promise.resolve();
	}
}
