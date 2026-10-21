import { describe, expect, it } from "vitest";
import { UsageCounter } from "../../src/runner/sdk-usage";

const start = (id: string, usage: Record<string, number>) => ({
	type: "message_start",
	message: { id, usage },
});
const delta = (output_tokens: number) => ({
	type: "message_delta",
	usage: { output_tokens },
});
const stop = { type: "message_stop" };

const split = (
	tokensIn: number,
	tokensOut: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
) => ({ tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens });

describe("UsageCounter", () => {
	it("counts a message once, at its stop, with the last output count, not message_start's placeholder", () => {
		const c = new UsageCounter();
		expect(
			c.onEvent(
				start("m1", {
					input_tokens: 100,
					output_tokens: 1,
					cache_read_input_tokens: 50,
					cache_creation_input_tokens: 10,
				}),
			),
		).toBeNull();
		expect(c.onEvent({ type: "content_block_delta" })).toBeNull();
		expect(c.onEvent(delta(20))).toBeNull();
		expect(c.onEvent(delta(42))).toBeNull();
		expect(c.onEvent(stop)).toEqual(split(100, 42, 50, 10));
		expect(c.countedTotal).toEqual(split(100, 42, 50, 10));
	});

	it("never counts the same message id twice", () => {
		const c = new UsageCounter();
		for (const _ of [1, 2]) {
			c.onEvent(start("m1", { input_tokens: 5, output_tokens: 0 }));
			c.onEvent(delta(3));
			c.onEvent(stop);
		}
		expect(c.countedTotal).toEqual(split(5, 3));
		c.onEvent(start("m2", { input_tokens: 7, output_tokens: 0 }));
		expect(c.onEvent(stop)).toEqual(split(7, 0));
		expect(c.countedTotal).toEqual(split(12, 3));
	});

	it("ignores a stop with no start, and a message that cost nothing", () => {
		const c = new UsageCounter();
		expect(c.onEvent(stop)).toBeNull();
		c.onEvent(start("m0", {}));
		expect(c.onEvent(stop)).toBeNull();
		expect(c.countedTotal).toEqual(split(0, 0));
	});

	it("counts what the result's totals exceed the counted total by, field by field, and only once", () => {
		const c = new UsageCounter();
		c.onEvent(start("m1", { input_tokens: 100, output_tokens: 0 }));
		c.onEvent(delta(40));
		c.onEvent(stop);
		const totals = {
			"claude-sonnet-5-5": {
				inputTokens: 90,
				outputTokens: 50,
				cacheReadInputTokens: 30,
				cacheCreationInputTokens: 0,
			},
			"claude-haiku-5-5": {
				inputTokens: 25,
				outputTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 4,
			},
		};
		// Input 115 - 100, output 55 - 40, cache read 30, cache write 4.
		expect(c.onResult(totals)).toEqual(split(15, 15, 30, 4));
		expect(c.onResult(totals)).toBeNull();
		expect(c.countedTotal).toEqual(split(115, 55, 30, 4));
	});

	it("reads the message still streaming, read only, until its stop counts it", () => {
		const c = new UsageCounter();
		expect(c.streaming).toEqual(split(0, 0));
		c.onEvent(start("m1", { input_tokens: 100, output_tokens: 1 }));
		c.onEvent(delta(30));
		expect(c.streaming).toEqual(split(100, 30));
		expect(c.streaming).toEqual(split(100, 30));
		expect(c.countedTotal).toEqual(split(0, 0));
		expect(c.onEvent(stop)).toEqual(split(100, 30));
		expect(c.streaming).toEqual(split(0, 0));
		// A message already counted is never pending again.
		c.onEvent(start("m1", { input_tokens: 100, output_tokens: 1 }));
		expect(c.streaming).toEqual(split(0, 0));
	});
});
