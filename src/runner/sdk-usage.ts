import type { TokenSplit } from "../lib/prices";

/**
 * Token counting for AgentSdkHarness (step 9d; docs/STEP-9-PLAN.md, Usage).
 * Pure: it reads Messages API stream events and the SDK's result totals and
 * returns splits for the runner to count.
 *
 * A message's output_tokens is a placeholder at message_start; message_delta
 * carries the running count. So a message is counted once, at its
 * message_stop, from the last values seen, and never again for the same
 * message id. The SDK's result carries per-model totals for every call it
 * made, streamed or not; whatever those exceed what was counted is counted
 * then, so the runner's total never ends below the SDK's.
 */

type StreamUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
};

/** The stream events this reads; anything else is ignored. */
export type UsageStreamEvent =
	| { type: "message_start"; message: { id: string; usage?: StreamUsage } }
	| { type: "message_delta"; usage?: StreamUsage | null }
	| { type: "message_stop" }
	| { type: string };

/** The SDK result's per-model totals, as ModelUsage carries them. */
export type ResultModelUsage = Record<
	string,
	{
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
	}
>;

const ZERO: TokenSplit = {
	tokensIn: 0,
	tokensOut: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

const n = (v: number | null | undefined) =>
	typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;

function add(a: TokenSplit, b: TokenSplit): TokenSplit {
	return {
		tokensIn: a.tokensIn + b.tokensIn,
		tokensOut: a.tokensOut + b.tokensOut,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
	};
}

function isZero(s: TokenSplit): boolean {
	return (
		s.tokensIn === 0 &&
		s.tokensOut === 0 &&
		s.cacheReadTokens === 0 &&
		s.cacheWriteTokens === 0
	);
}

/** Later values win: message_delta's counts are running totals for the message. */
function merge(into: TokenSplit, usage: StreamUsage | null | undefined) {
	if (!usage) return into;
	return {
		tokensIn:
			usage.input_tokens == null ? into.tokensIn : n(usage.input_tokens),
		tokensOut:
			usage.output_tokens == null ? into.tokensOut : n(usage.output_tokens),
		cacheReadTokens:
			usage.cache_read_input_tokens == null
				? into.cacheReadTokens
				: n(usage.cache_read_input_tokens),
		cacheWriteTokens:
			usage.cache_creation_input_tokens == null
				? into.cacheWriteTokens
				: n(usage.cache_creation_input_tokens),
	};
}

export class UsageCounter {
	private current: { id: string; split: TokenSplit } | null = null;
	private readonly counted = new Set<string>();
	private total: TokenSplit = ZERO;

	/** Everything counted so far. */
	get countedTotal(): TokenSplit {
		return this.total;
	}

	/**
	 * The counts so far of the message still streaming, which its
	 * message_stop would count; zero when none is. Read only.
	 */
	get streaming(): TokenSplit {
		const c = this.current;
		return c && !this.counted.has(c.id) ? c.split : ZERO;
	}

	/** One stream event; a split to count when a message ends, else null. */
	onEvent(event: UsageStreamEvent): TokenSplit | null {
		if (event.type === "message_start") {
			const e = event as Extract<UsageStreamEvent, { type: "message_start" }>;
			this.current = { id: e.message.id, split: merge(ZERO, e.message.usage) };
			return null;
		}
		if (event.type === "message_delta" && this.current) {
			const e = event as Extract<UsageStreamEvent, { type: "message_delta" }>;
			this.current.split = merge(this.current.split, e.usage);
			return null;
		}
		if (event.type === "message_stop" && this.current) {
			const { id, split } = this.current;
			this.current = null;
			if (this.counted.has(id)) return null;
			this.counted.add(id);
			this.total = add(this.total, split);
			return isZero(split) ? null : split;
		}
		return null;
	}

	/**
	 * The SDK's totals at its result: what they exceed the counted total by,
	 * field by field, or null when they exceed it by nothing. Counted too.
	 */
	onResult(modelUsage: ResultModelUsage): TokenSplit | null {
		const sdk = Object.values(modelUsage).reduce<TokenSplit>(
			(acc, u) =>
				add(acc, {
					tokensIn: n(u.inputTokens),
					tokensOut: n(u.outputTokens),
					cacheReadTokens: n(u.cacheReadInputTokens),
					cacheWriteTokens: n(u.cacheCreationInputTokens),
				}),
			ZERO,
		);
		const rest: TokenSplit = {
			tokensIn: Math.max(0, sdk.tokensIn - this.total.tokensIn),
			tokensOut: Math.max(0, sdk.tokensOut - this.total.tokensOut),
			cacheReadTokens: Math.max(
				0,
				sdk.cacheReadTokens - this.total.cacheReadTokens,
			),
			cacheWriteTokens: Math.max(
				0,
				sdk.cacheWriteTokens - this.total.cacheWriteTokens,
			),
		};
		if (isZero(rest)) return null;
		this.total = add(this.total, rest);
		return rest;
	}
}
