import type { CanonCitation } from "../../lib/canon";
import type { TokenSplit } from "../../lib/prices";
import type { CanonPrompt } from "./prompt";

/**
 * What runs Canon's model, behind the narrowest interface a turn needs: a
 * prompt in, usage and one reply out, with Canon's tools called in process
 * as the model asks. The FakeCanonModel plays scripts and is the tests'
 * model; the Agent SDK one (sdk-model.ts) is never run by tests.
 */

export const CANON_TOOL_NAMES = [
	"ask_operator",
	"draft_brief",
	"propose_memory",
	"recommend_roster",
] as const;

export type CanonToolName = (typeof CANON_TOOL_NAMES)[number];

/** What a tool hands back to the model. */
export type ToolResult = { text: string; isError?: boolean };

export type CanonToolCall = (
	name: CanonToolName,
	input: unknown,
) => Promise<ToolResult>;

export type CanonModelEvent =
	/** Tokens spent since the last event, to add to the session's counts. */
	| { kind: "usage"; split: TokenSplit }
	/** Canon's final text and what it cites, as the API returned them. */
	| { kind: "reply"; text: string; citations: CanonCitation[] };

export type CanonModelRun = {
	sessionId: string;
	/** The session's frozen model id. */
	model: string;
	prompt: CanonPrompt;
	callTool: CanonToolCall;
	/** Aborted when the turn stops the model, as at the hard ceiling. */
	signal: AbortSignal;
};

export type CanonModel = {
	/** The harness and its version: canon_session.harness_version at open. */
	readonly version: string;
	/** The turn's events. A run that ends with no reply asked or did its work through tools. Throws when the model fails. */
	run(input: CanonModelRun): AsyncIterable<CanonModelEvent>;
};

export const FAKE_CANON_VERSION = "fake-canon@1";

export type FakeCanonStep =
	| { usage: TokenSplit }
	| { tool: CanonToolName; input: unknown }
	| { reply: string; citations?: CanonCitation[] }
	| { fail: string };

/**
 * Plays one script per session, in order: usage events, tool calls through
 * the turn's own tools, a reply, or a failure. Records what it was given.
 * A session with no script plays `unscripted`, which is empty unless given.
 */
export class FakeCanonModel implements CanonModel {
	readonly version = FAKE_CANON_VERSION;
	private readonly scripts = new Map<string, FakeCanonStep[]>();
	private readonly unscripted: readonly FakeCanonStep[];

	constructor(options: { unscripted?: FakeCanonStep[] } = {}) {
		this.unscripted = options.unscripted ?? [];
	}
	/** Every prompt a run was given, in order. */
	readonly prompts: CanonPrompt[] = [];
	/** Every tool call and what it returned, in order. */
	readonly toolCalls: Array<{
		name: CanonToolName;
		input: unknown;
		result: ToolResult;
	}> = [];

	script(sessionId: string, steps: FakeCanonStep[]): void {
		this.scripts.set(sessionId, steps);
	}

	async *run(input: CanonModelRun): AsyncIterable<CanonModelEvent> {
		this.prompts.push(input.prompt);
		const steps = this.scripts.get(input.sessionId) ?? this.unscripted;
		this.scripts.delete(input.sessionId);
		for (const step of steps) {
			if (input.signal.aborted) return;
			if ("usage" in step) {
				yield { kind: "usage", split: { ...step.usage } };
			} else if ("tool" in step) {
				const result = await input.callTool(step.tool, step.input);
				this.toolCalls.push({ name: step.tool, input: step.input, result });
			} else if ("reply" in step) {
				yield {
					kind: "reply",
					text: step.reply,
					citations: step.citations ?? [],
				};
			} else {
				throw new Error(step.fail);
			}
		}
	}
}

/** What Canon says when no model is connected. */
export const NO_MODEL_REPLY =
	"No model is connected to this server, so Canon cannot read this project. Set AVEL_HARNESS=agent-sdk and ANTHROPIC_API_KEY, then restart the server.";

/**
 * Canon without a real model: every turn ends with NO_MODEL_REPLY, so a
 * posted message never leaves its session mid-turn. The server runs this
 * unless AVEL_HARNESS=agent-sdk, the way dispatches run the FakeHarness.
 */
export function offlineCanonModel(): FakeCanonModel {
	return new FakeCanonModel({ unscripted: [{ reply: NO_MODEL_REPLY }] });
}
