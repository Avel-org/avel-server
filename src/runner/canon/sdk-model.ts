import { mkdir } from "node:fs/promises";
import {
	createSdkMcpServer,
	type HookCallback,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
	query as sdkQuery,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { askOperatorInput, type CanonCitation } from "../../lib/canon";
import type { Logger } from "../../lib/logger";
import { AGENT_SDK_VERSION, sdkEnv } from "../agent-sdk-harness";
import {
	type ResultModelUsage,
	UsageCounter,
	type UsageStreamEvent,
} from "../sdk-usage";
import { fetchInput } from "./fetch";
import {
	CANON_TOOL_NAMES,
	type CanonModel,
	type CanonModelEvent,
	type CanonModelRun,
	type CanonToolCall,
	type CanonToolName,
	type ToolResult,
} from "./model";
import type { CanonPrompt } from "./prompt";
import {
	draftBriefInput,
	proposeMemoryInput,
	recommendRosterInput,
} from "./tools";

/**
 * Canon on the Claude Agent SDK, the way agent-sdk-harness.ts runs a
 * dispatch: Canon's four tools on an in-process MCP server and nothing
 * else, no built-in tool, no settings, no CLAUDE.md, a hook denying every
 * other tool, and an environment with no database URL. Never run by tests:
 * they script the query.
 *
 * [hypothesis], unverified without a real call: that the SDK passes
 * search_result blocks in a user message through to the API unchanged, and
 * returns search_result_location citations on the assistant's text blocks.
 * The SDK's types allow both (SDKUserMessage.message is a MessageParam;
 * assistant content is a BetaMessage).
 */

const SERVER = "canon";

/** The tool names the model may call, as the SDK prefixes them. */
export const CANON_TOOL_IDS = CANON_TOOL_NAMES.map(
	(t) => `mcp__${SERVER}__${t}`,
);

/** A PreToolUse hook that denies every tool but these SDK ids. */
export function denyNotIn(ids: readonly string[]): HookCallback {
	return async (input) => {
		const name = "tool_name" in input ? String(input.tool_name) : "";
		if (ids.includes(name)) return {};
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: `${name} is not one of this turn's tools`,
			},
		};
	};
}

export const denyNonCanon: HookCallback = denyNotIn(CANON_TOOL_IDS);

export type CanonQueryFn = (params: {
	prompt: string | AsyncIterable<SDKUserMessage>;
	options?: Options;
}) => AsyncIterable<SDKMessage>;

export type AgentSdkCanonModelOptions = {
	apiKey: string;
	/** A directory of Canon's own: CLAUDE_CONFIG_DIR, HOME and the cwd. */
	configDir: string;
	logger: Logger;
	/** Backstops; the turn holds the real budget. */
	maxBudgetUsd: number;
	maxTurns: number;
	query?: CanonQueryFn;
	hostEnv?: NodeJS.ProcessEnv;
};

function result(r: ToolResult) {
	return {
		content: [{ type: "text" as const, text: r.text }],
		...(r.isError ? { isError: true } : {}),
	};
}

function canonServer(
	callTool: CanonToolCall,
	allowed: readonly CanonToolName[],
) {
	return createSdkMcpServer({
		name: SERVER,
		version: "1",
		tools: [
			tool(
				"ask_operator",
				"Ask the operator when you cannot decide from the documents: 2 to 4 options, why you ask, and the chunk ids of the passages that raised it.",
				askOperatorInput.shape,
				async (a) => result(await callTool("ask_operator", a)),
			),
			tool(
				"draft_brief",
				"Save the brief in the intake's shape: summary, requirements and acceptance criteria, no modules. Returns what the intake check found.",
				draftBriefInput.shape,
				async (a) => result(await callTool("draft_brief", a)),
			),
			tool(
				"propose_memory",
				"Propose one lasting fact about this client for the operator to keep.",
				proposeMemoryInput.shape,
				async (a) => result(await callTool("propose_memory", a)),
			),
			tool(
				"recommend_roster",
				"Recommend the agents for this project, each with why.",
				recommendRosterInput.shape,
				async (a) => result(await callTool("recommend_roster", a)),
			),
			tool(
				"fetch",
				"Read the command center's own data: one entity (clients, engagements, intakes, missions, dispatches, spend, activity, gate_runs, findings), optionally one row by id, filtered by clientId, engagementId, missionId or status. Returns the rows as JSON; the operator sees them as a table or a card.",
				fetchInput.shape,
				async (a) => result(await callTool("fetch", a)),
			),
			tool(
				"name_session",
				"Name this conversation, once, in a few plain words. Only while it has no title.",
				{ title: z.string() },
				async (a) => result(await callTool("name_session", a)),
			),
		].filter((t) => allowed.includes(t.name as CanonToolName)),
	});
}

/** The memory and the conversation, as the text after the knowledge. */
function transcriptText(prompt: CanonPrompt): string {
	const memory =
		prompt.memory.length === 0
			? "No kept memory for this client."
			: `Kept memory for this client:\n${prompt.memory.map((m) => `- ${m}`).join("\n")}`;
	const turns = prompt.transcript
		.map(
			(m) => `${m.role === "operator" ? "Operator" : "Canon"}:\n${m.contentMd}`,
		)
		.join("\n\n");
	return `${memory}\n\nThe conversation so far:\n\n${turns}\n\nAnswer the operator's last message.`;
}

async function* oneMessage(prompt: CanonPrompt): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		parent_tool_use_id: null,
		message: {
			role: "user",
			content: [
				...prompt.knowledge,
				{ type: "text", text: transcriptText(prompt) },
			] as SDKUserMessage["message"]["content"],
		},
	};
}

/** A top-level text or thinking delta, as one model event; anything else null. */
function streamDelta(m: SDKMessage): CanonModelEvent | null {
	if (m.type !== "stream_event" || m.parent_tool_use_id !== null) return null;
	const e = m.event as {
		type?: string;
		delta?: { type?: string; text?: string; thinking?: string };
	};
	if (e.type !== "content_block_delta" || !e.delta) return null;
	if (e.delta.type === "text_delta" && e.delta.text) {
		return { kind: "text", text: e.delta.text };
	}
	if (e.delta.type === "thinking_delta" && e.delta.thinking) {
		return { kind: "reasoning", text: e.delta.thinking };
	}
	return null;
}

type TextBlock = {
	type: "text";
	text: string;
	citations?: Array<{
		type: string;
		source?: string;
		cited_text?: string;
	}> | null;
};

export class AgentSdkCanonModel implements CanonModel {
	readonly version = `claude-agent-sdk@${AGENT_SDK_VERSION}`;
	private readonly options: AgentSdkCanonModelOptions;
	private readonly query: CanonQueryFn;

	constructor(options: AgentSdkCanonModelOptions) {
		this.options = options;
		this.query = options.query ?? (sdkQuery as CanonQueryFn);
	}

	/** The SDK options for one turn. Exported shape, for tests. */
	turnOptions(input: CanonModelRun, abort: AbortController): Options {
		const o = this.options;
		const ids = input.tools.map((t) => `mcp__${SERVER}__${t}`);
		return {
			cwd: o.configDir,
			model: input.model,
			settingSources: [],
			strictMcpConfig: true,
			tools: [],
			// Only this turn's mode's tools: none at all in ask mode.
			mcpServers:
				input.tools.length > 0
					? { [SERVER]: canonServer(input.callTool, input.tools) }
					: {},
			allowedTools: ids,
			disallowedTools: ["Agent", "Task"],
			permissionMode: "dontAsk",
			hooks: { PreToolUse: [{ hooks: [denyNotIn(ids)] }] },
			systemPrompt: input.prompt.system,
			maxTurns: o.maxTurns,
			maxBudgetUsd: o.maxBudgetUsd,
			abortController: abort,
			env: sdkEnv(o.hostEnv ?? process.env, o.apiKey, o.configDir),
			includePartialMessages: true,
			persistSession: false,
		};
	}

	/**
	 * Usage as it comes, then one reply: the text written after Canon's last
	 * tool call, with its search-result citations. Text before a tool call is
	 * working talk and is dropped; a turn whose last act was a tool call ends
	 * with no reply.
	 */
	async *run(input: CanonModelRun): AsyncIterable<CanonModelEvent> {
		const abort = new AbortController();
		input.signal.addEventListener("abort", () => abort.abort(), { once: true });
		const usage = new UsageCounter();
		let blocks: TextBlock[] = [];
		// The turn runs in configDir, and a process cannot start in a folder
		// that does not exist; nothing else creates it.
		await mkdir(this.options.configDir, { recursive: true });
		const messages = this.query({
			prompt: oneMessage(input.prompt),
			options: this.turnOptions(input, abort),
		});
		for await (const m of messages) {
			if (abort.signal.aborted) return;
			if (m.type === "stream_event") {
				const split = usage.onEvent(m.event as UsageStreamEvent);
				if (split) yield { kind: "usage", split };
				// Text and the reasoning summary as they stream, for the run
				// trace. A summary only: the API returns no raw reasoning for
				// these models. Whether the SDK passes thinking deltas through
				// is a [hypothesis] until a live run.
				const delta = streamDelta(m);
				if (delta) yield delta;
			} else if (m.type === "assistant" && m.parent_tool_use_id === null) {
				for (const block of m.message.content as Array<{ type: string }>) {
					if (block.type === "tool_use") blocks = [];
					else if (block.type === "text") blocks.push(block as TextBlock);
				}
			} else if (m.type === "result") {
				const rest = usage.onResult(
					(m as { modelUsage: ResultModelUsage }).modelUsage,
				);
				if (rest) yield { kind: "usage", split: rest };
			}
		}
		const text = blocks.map((b) => b.text).join("");
		if (text.trim() === "") return;
		const citations: CanonCitation[] = [];
		for (const b of blocks) {
			for (const c of b.citations ?? []) {
				if (
					c.type === "search_result_location" &&
					c.source &&
					c.cited_text !== undefined
				) {
					citations.push({ source: c.source, cited_text: c.cited_text });
				}
			}
		}
		yield { kind: "reply", text, citations };
	}
}
