import {
	PRICE_TABLES,
	PRICE_VERSION,
	type PriceTable,
	spendUsd,
	type TokenSplit,
} from "../lib/prices";

/**
 * Budget accounting (module 6; SANDBOX.md, The runner enforces budget).
 * Pure: no clock, no IO. The runner applies what these return.
 */

/** The price tables by version, and the version a new dispatch starts under. */
export type PriceBook = {
	current: string;
	tables: Readonly<Record<string, PriceTable>>;
};

/** src/lib/prices.ts's tables, every version. Tests pass their own book. */
export const DEFAULT_PRICE_BOOK: PriceBook = {
	current: PRICE_VERSION,
	tables: PRICE_TABLES,
};

/** The table a version names, or undefined when the book has no such version. */
export function tableFor(
	book: PriceBook,
	version: string,
): PriceTable | undefined {
	return Object.hasOwn(book.tables, version) ? book.tables[version] : undefined;
}

/** The dispatch fields one usage step reads. */
export type BudgetState = TokenSplit & {
	model: string;
	tokenSoftCeiling: number;
	tokenHardCeiling: number;
	softCeilingCrossed: boolean;
};

/** The dispatch fields one usage step writes, and what it crossed. */
export type BudgetStep = TokenSplit & {
	tokensUsed: number;
	/** numeric(14,6), as stored. */
	spendUsd: string;
	softCeilingCrossed: boolean;
	/** True only on the step that first reaches the soft ceiling. */
	crossedSoftNow: boolean;
	/** The dispatch has reached its hard ceiling. */
	hardReached: boolean;
};

/**
 * Adds one step's tokens to the dispatch's counts and reprices the whole
 * split at the dispatch's frozen table. Reaching a ceiling counts: the soft
 * one at tokensUsed >= soft, the hard one at tokensUsed >= hard. Throws when
 * the table does not price the model, which start refuses, so it is a bug.
 */
export function addUsage(
	state: BudgetState,
	step: TokenSplit,
	table: PriceTable,
): BudgetStep {
	const split: TokenSplit = {
		tokensIn: state.tokensIn + step.tokensIn,
		tokensOut: state.tokensOut + step.tokensOut,
		cacheReadTokens: state.cacheReadTokens + step.cacheReadTokens,
		cacheWriteTokens: state.cacheWriteTokens + step.cacheWriteTokens,
	};
	const tokensUsed =
		split.tokensIn +
		split.tokensOut +
		split.cacheReadTokens +
		split.cacheWriteTokens;
	const spend = spendUsd(state.model, split, table);
	if (spend === undefined) {
		throw new Error(`no price for ${state.model} in the dispatch's table`);
	}
	const softNow = tokensUsed >= state.tokenSoftCeiling;
	return {
		...split,
		tokensUsed,
		spendUsd: spend.toFixed(6),
		softCeilingCrossed: state.softCeilingCrossed || softNow,
		crossedSoftNow: softNow && !state.softCeilingCrossed,
		hardReached: tokensUsed >= state.tokenHardCeiling,
	};
}

/** Whether a mission's spend has reached its ceiling. No ceiling never halts. */
export function spendCeilingReached(
	spentUsd: number,
	ceilingUsd: string | null,
): boolean {
	return ceilingUsd !== null && spentUsd >= Number(ceilingUsd);
}

const MINUTE = 60_000;

/** Whether a run started at `startedAt` has used up its wall clock at `now`. */
export function wallClockSpent(
	startedAt: Date,
	wallClockMinutes: number,
	now: Date,
): boolean {
	return now.getTime() - startedAt.getTime() >= wallClockMinutes * MINUTE;
}
