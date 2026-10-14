/**
 * Model prices (module 6). A dispatch records the price version it started
 * under, so its spend can be recomputed exactly later. Pure: no clock, no IO.
 *
 * Only the dev and test harness is priced here. Real model prices come from
 * the operator, never from memory (BE lead, 2026-10-13).
 */

/** Bumped whenever any price in PRICES changes. Stored as dispatch.price_version. */
export const PRICE_VERSION = "prices-2026-10-13";

/** US dollars per million tokens, at most six decimal places. */
export type ModelPrice = {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok: number;
	cacheWritePerMTok: number;
};

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export const PRICES: PriceTable = {
	"fake-harness": {
		inputPerMTok: 0,
		outputPerMTok: 0,
		cacheReadPerMTok: 0,
		cacheWritePerMTok: 0,
	},
};

/** A dispatch's four token counts, as the runner reports them. */
export type TokenSplit = {
	tokensIn: number;
	tokensOut: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
};

/** The model's price, or undefined when the table does not price it. */
export function priceFor(
	model: string,
	table: PriceTable = PRICES,
): ModelPrice | undefined {
	return Object.hasOwn(table, model) ? table[model] : undefined;
}

const PRICE = /^(\d+)(?:\.(\d{1,6}))?$/;

/** A price as an exact count of micro-dollars per million tokens. */
function microPerMTok(price: number): bigint {
	const m = PRICE.exec(String(price));
	if (!m) {
		throw new RangeError(
			`price ${price} is not a non-negative decimal with at most 6 places`,
		);
	}
	return (
		BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))
	);
}

function count(name: string, n: number): bigint {
	if (!Number.isSafeInteger(n) || n < 0) {
		throw new RangeError(`${name} must be a non-negative integer, got ${n}`);
	}
	return BigInt(n);
}

/**
 * What a split costs in US dollars, rounded half-up to six decimal places
 * (spend_usd is numeric(14,6)). Integer arithmetic throughout: each count
 * times its micro-dollar price gives micro-dollars times a million, summed
 * before the one rounding, so no float error accrues. Undefined when the
 * model is not priced.
 */
export function spendUsd(
	model: string,
	split: TokenSplit,
	table: PriceTable = PRICES,
): number | undefined {
	const price = priceFor(model, table);
	if (!price) return undefined;
	const scaled =
		count("tokensIn", split.tokensIn) * microPerMTok(price.inputPerMTok) +
		count("tokensOut", split.tokensOut) * microPerMTok(price.outputPerMTok) +
		count("cacheReadTokens", split.cacheReadTokens) *
			microPerMTok(price.cacheReadPerMTok) +
		count("cacheWriteTokens", split.cacheWriteTokens) *
			microPerMTok(price.cacheWritePerMTok);
	const micro = (scaled + 500_000n) / 1_000_000n;
	return Number(micro) / 1_000_000;
}
