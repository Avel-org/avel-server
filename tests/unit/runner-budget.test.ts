import { describe, expect, it } from "vitest";
import { PRICE_VERSION, PRICES, type TokenSplit } from "../../src/lib/prices";
import {
	addUsage,
	type BudgetState,
	DEFAULT_PRICE_BOOK,
	spendCeilingReached,
	tableFor,
	wallClockSpent,
} from "../../src/runner/budget";

const table = {
	priced: {
		inputPerMTok: 3,
		outputPerMTok: 15,
		cacheReadPerMTok: 0.3,
		cacheWritePerMTok: 3.75,
	},
};

const zero: TokenSplit = {
	tokensIn: 0,
	tokensOut: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

const state = (over: Partial<BudgetState> = {}): BudgetState => ({
	...zero,
	model: "priced",
	tokenSoftCeiling: 1500,
	tokenHardCeiling: 3000,
	softCeilingCrossed: false,
	...over,
});

const usage = (tokensIn: number, tokensOut = 0): TokenSplit => ({
	...zero,
	tokensIn,
	tokensOut,
});

describe("addUsage", () => {
	it("adds each count and reprices the whole split at the table", () => {
		const next = addUsage(
			state({
				tokensIn: 100,
				tokensOut: 10,
				cacheReadTokens: 1,
				cacheWriteTokens: 2,
			}),
			{
				tokensIn: 900_000,
				tokensOut: 99_990,
				cacheReadTokens: 999_999,
				cacheWriteTokens: 999_998,
			},
			table,
		);
		expect(next).toMatchObject({
			tokensIn: 900_100,
			tokensOut: 100_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
			tokensUsed: 3_000_100,
		});
		// 0.9001 × 3 + 0.1 × 15 + 1 × 0.3 + 1 × 3.75
		expect(next.spendUsd).toBe("8.250300");
	});

	it("crosses the soft ceiling once, on reaching it", () => {
		const below = addUsage(state(), usage(1499), table);
		expect(below).toMatchObject({
			softCeilingCrossed: false,
			crossedSoftNow: false,
		});
		const at = addUsage(state({ tokensIn: 1499 }), usage(1), table);
		expect(at).toMatchObject({
			softCeilingCrossed: true,
			crossedSoftNow: true,
		});
		const after = addUsage(
			state({ tokensIn: 1500, softCeilingCrossed: true }),
			usage(1),
			table,
		);
		expect(after).toMatchObject({
			softCeilingCrossed: true,
			crossedSoftNow: false,
		});
	});

	it("reaches the hard ceiling at exactly the ceiling", () => {
		expect(addUsage(state(), usage(2999), table).hardReached).toBe(false);
		expect(addUsage(state(), usage(3000), table).hardReached).toBe(true);
		expect(addUsage(state(), usage(2000, 1000), table).hardReached).toBe(true);
	});

	it("refuses a model the table does not price", () => {
		expect(() =>
			addUsage(state({ model: "unpriced" }), usage(1), table),
		).toThrow(/no price for unpriced/);
	});
});

describe("spendCeilingReached", () => {
	it("halts at the ceiling, never without one", () => {
		expect(spendCeilingReached(14.999999, "15.00")).toBe(false);
		expect(spendCeilingReached(15, "15.00")).toBe(true);
		expect(spendCeilingReached(16, "15.00")).toBe(true);
		expect(spendCeilingReached(1_000, null)).toBe(false);
	});
});

describe("wallClockSpent", () => {
	const start = new Date("2026-10-13T12:00:00.000Z");
	it("is spent at started_at + wall_clock_minutes, not before", () => {
		const at = (ms: number) => new Date(start.getTime() + ms);
		expect(wallClockSpent(start, 60, at(60 * 60_000 - 1))).toBe(false);
		expect(wallClockSpent(start, 60, at(60 * 60_000))).toBe(true);
		expect(wallClockSpent(start, 480, at(9436 * 60_000))).toBe(true);
	});
});

describe("tableFor", () => {
	it("finds a version's table, and no inherited key", () => {
		expect(tableFor(DEFAULT_PRICE_BOOK, PRICE_VERSION)).toBe(PRICES);
		expect(DEFAULT_PRICE_BOOK.current).toBe(PRICE_VERSION);
		expect(tableFor(DEFAULT_PRICE_BOOK, "toString")).toBeUndefined();
		expect(tableFor(DEFAULT_PRICE_BOOK, "prices-1999")).toBeUndefined();
	});
});
