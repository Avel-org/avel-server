import type {
	HookInput,
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../../src/lib/logger";
import { buildCanonPrompt } from "../../../src/runner/canon";
import {
	CANON_TOOL_NAMES,
	type CanonModelEvent,
	type CanonToolName,
} from "../../../src/runner/canon/model";
import {
	AgentSdkCanonModel,
	CANON_TOOL_IDS,
	denyNonCanon,
} from "../../../src/runner/canon/sdk-model";

// The Agent SDK model with a scripted query: no real model is called. It
// checks the options the SDK gets and how its messages become events.

const SHA = "b".repeat(64);
const built = buildCanonPrompt({
	identityMd: "# Canon\n",
	files: [{ fileId: "f1", sha256: SHA, name: "a.md", contentMd: "# A\nOne." }],
	memory: ["Kept fact."],
	messages: [{ seq: 1, role: "operator", contentMd: "Brief this." }],
});
const source = built.prompt.knowledge[0]?.source as string;

function scripted(messages: unknown[]) {
	const seen: { prompt: SDKUserMessage[]; options?: Options } = { prompt: [] };
	const query = (params: {
		prompt: string | AsyncIterable<SDKUserMessage>;
		options?: Options;
	}) => {
		seen.options = params.options;
		return (async function* () {
			if (typeof params.prompt !== "string") {
				for await (const m of params.prompt) seen.prompt.push(m);
			}
			for (const m of messages) yield m as SDKMessage;
		})();
	};
	return { seen, query };
}

async function drain(model: AgentSdkCanonModel, calls: CanonToolName[] = []) {
	const events: CanonModelEvent[] = [];
	for await (const e of model.run({
		sessionId: "s1",
		model: "claude-sonnet-5-5",
		prompt: built.prompt,
		tools: CANON_TOOL_NAMES,
		callTool: async (name) => {
			calls.push(name);
			return { text: "ok" };
		},
		signal: new AbortController().signal,
	})) {
		events.push(e);
	}
	return events;
}

const assistant = (content: unknown[], parent: string | null = null) => ({
	type: "assistant",
	parent_tool_use_id: parent,
	message: { content },
});

const make = (query: ReturnType<typeof scripted>["query"]) =>
	new AgentSdkCanonModel({
		apiKey: "test-key",
		configDir: "C:/avel/canon",
		logger: silentLogger(),
		maxBudgetUsd: 1,
		maxTurns: 10,
		query,
		hostEnv: { PATH: "/bin", DATABASE_URL: "postgres://secret" },
	});

describe("AgentSdkCanonModel", () => {
	it("gives the SDK Canon's tools and nothing else", async () => {
		const { seen, query } = scripted([]);
		await drain(make(query));
		const o = seen.options as Options;
		expect(o).toMatchObject({
			model: "claude-sonnet-5-5",
			settingSources: [],
			strictMcpConfig: true,
			tools: [],
			allowedTools: [...CANON_TOOL_IDS],
			disallowedTools: ["Agent", "Task"],
			permissionMode: "dontAsk",
			systemPrompt: built.prompt.system,
			persistSession: false,
			maxTurns: 10,
			maxBudgetUsd: 1,
		});
		expect(Object.keys(o.mcpServers ?? {})).toEqual(["canon"]);
		expect(o.env?.DATABASE_URL).toBeUndefined();
		expect(CANON_TOOL_IDS).toEqual([
			"mcp__canon__ask_operator",
			"mcp__canon__draft_brief",
			"mcp__canon__propose_memory",
			"mcp__canon__recommend_roster",
		]);
	});

	it("denies every tool that is not Canon's", async () => {
		const decide = async (tool_name: string) =>
			denyNonCanon({ tool_name } as unknown as HookInput, undefined, {
				signal: new AbortController().signal,
			});
		expect(await decide("mcp__canon__ask_operator")).toEqual({});
		for (const name of [
			"Bash",
			"Read",
			"mcp__avel__room_write",
			"mcp__canon__other",
		]) {
			expect(await decide(name)).toMatchObject({
				hookSpecificOutput: { permissionDecision: "deny" },
			});
		}
	});

	it("sends the knowledge as search results, then the memory and conversation as text", async () => {
		const { seen, query } = scripted([]);
		await drain(make(query));
		expect(seen.prompt).toHaveLength(1);
		const content = seen.prompt[0]?.message.content as unknown[];
		expect(content.slice(0, -1)).toEqual(built.prompt.knowledge);
		const last = content.at(-1) as { type: string; text: string };
		expect(last.type).toBe("text");
		expect(last.text).toContain("Kept fact.");
		expect(last.text).toContain("Brief this.");
	});

	it("turns the final text after the last tool call into the reply, with its search-result citations", async () => {
		const { query } = scripted([
			assistant([{ type: "text", text: "Let me ask first." }]),
			assistant([
				{
					type: "tool_use",
					id: "t1",
					name: "mcp__canon__ask_operator",
					input: {},
				},
			]),
			assistant([
				{
					type: "text",
					text: "One thing is known.",
					citations: [
						{
							type: "search_result_location",
							source,
							cited_text: "# A\nOne.",
							title: "a.md > A",
							search_result_index: 0,
							start_block_index: 0,
							end_block_index: 1,
						},
						// Valid in every field but its kind: only the kind may exclude it.
						{ type: "char_location", source, cited_text: "# A\nOne." },
					],
				},
			]),
			assistant([{ type: "text", text: "Subagent text." }], "t9"),
			{
				type: "result",
				subtype: "success",
				modelUsage: {
					"claude-sonnet-5-5": {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
					},
				},
			},
		]);
		const events = await drain(make(query));
		expect(events).toEqual([
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
				kind: "reply",
				text: "One thing is known.",
				citations: [{ source, cited_text: "# A\nOne." }],
			},
		]);
	});

	it("ends with no reply when the last thing it did was call a tool", async () => {
		const { query } = scripted([
			assistant([{ type: "text", text: "Asking." }]),
			assistant([
				{
					type: "tool_use",
					id: "t1",
					name: "mcp__canon__ask_operator",
					input: {},
				},
			]),
		]);
		expect(await drain(make(query))).toEqual([]);
	});
});
