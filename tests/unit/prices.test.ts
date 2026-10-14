import { describe, expect, it } from "vitest";
import {
	PRICE_VERSION,
	PRICES,
	type PriceTable,
	priceFor,
	spendUsd,
	type TokenSplit,
} from "../../src/lib/prices";

// Made-up prices: the shipped table holds only the zero-priced harness, and
// real model prices come from the operator.
const TABLE: PriceTable = {
	"test-model": {
		inputPerMTok: 3,
		outputPerMTok: 15,
		cacheReadPerMTok: 0.3,
		cacheWritePerMTok: 3.75,
	},
	"half-micro": {
		inputPerMTok: 0.5,
		outputPerMTok: 0,
		cacheReadPerMTok: 0,
		cacheWritePerMTok: 0,
	},
};

const split = (
	tokensIn: number,
	tokensOut = 0,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
): TokenSplit => ({ tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens });

describe("prices", () => {
	it("ships only the zero-priced harness, under a dated version", () => {
		expect(PRICE_VERSION).toBe("prices-2026-10-13");
		expect(Object.keys(PRICES)).toEqual(["fake-harness"]);
		expect(
			spendUsd("fake-harness", split(10 ** 9, 10 ** 9, 10 ** 9, 10 ** 9)),
		).toBe(0);
	});

	it("prices only models in the table", () => {
		expect(priceFor("test-model", TABLE)?.outputPerMTok).toBe(15);
		expect(priceFor("unknown", TABLE)).toBeUndefined();
		expect(priceFor("toString", TABLE)).toBeUndefined();
		expect(spendUsd("unknown", split(1), TABLE)).toBeUndefined();
		expect(spendUsd("test-model", split(1))).toBeUndefined();
	});

	it("charges each count at its own price", () => {
		const M = 1_000_000;
		expect(spendUsd("test-model", split(M), TABLE)).toBe(3);
		expect(spendUsd("test-model", split(0, M), TABLE)).toBe(15);
		expect(spendUsd("test-model", split(0, 0, M), TABLE)).toBe(0.3);
		expect(spendUsd("test-model", split(0, 0, 0, M), TABLE)).toBe(3.75);
		expect(spendUsd("test-model", split(M, M, M, M), TABLE)).toBe(22.05);
		expect(spendUsd("test-model", split(0), TABLE)).toBe(0);
	});

	it("has none of a float's drift", () => {
		// 7 cache reads at 0.3/MTok: 7 * 0.3 / 1e6 in floats is
		// 0.0000021000000000000002. Exactly it is 2.1 micro-dollars, so 0.000002.
		expect(spendUsd("test-model", split(0, 0, 7), TABLE)).toBe(0.000002);
		expect(spendUsd("test-model", split(0, 0, 7_000_000), TABLE)).toBe(2.1);
		// 1234 in, 567 out, 89 cache read, 12 cache write:
		// 3702 + 8505 + 26.7 + 45 = 12278.7 micro-dollars, rounded up to 12279.
		expect(spendUsd("test-model", split(1234, 567, 89, 12), TABLE)).toBe(
			0.012279,
		);
	});

	it("rounds half up to six places, once, after summing", () => {
		// 1 token at 0.5/MTok is 0.0000005: exactly half a micro-dollar, up.
		expect(spendUsd("half-micro", split(1), TABLE)).toBe(0.000001);
		// 0.4999 micro-dollars rounds down.
		const below: PriceTable = {
			m: {
				inputPerMTok: 0.4999,
				outputPerMTok: 0,
				cacheReadPerMTok: 0,
				cacheWritePerMTok: 0,
			},
		};
		expect(spendUsd("m", split(1), below)).toBe(0);
		// Two halves sum to one micro-dollar; rounding each first would give two.
		const halves: PriceTable = {
			m: {
				inputPerMTok: 0.5,
				outputPerMTok: 0.5,
				cacheReadPerMTok: 0,
				cacheWritePerMTok: 0,
			},
		};
		expect(spendUsd("m", split(1, 1), halves)).toBe(0.000001);
	});

	it("refuses negative or fractional counts, and prices finer than a micro-dollar", () => {
		for (const bad of [split(-1), split(0, 1.5), split(0, 0, Number.NaN)]) {
			expect(() => spendUsd("test-model", bad, TABLE)).toThrow(RangeError);
		}
		const fine: PriceTable = {
			m: {
				inputPerMTok: 0.0000001,
				outputPerMTok: 0,
				cacheReadPerMTok: 0,
				cacheWritePerMTok: 0,
			},
		};
		expect(() => spendUsd("m", split(1), fine)).toThrow(RangeError);
	});
});
