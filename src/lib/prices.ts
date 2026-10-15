/**
 * Model prices (module 6). A dispatch records the price version it started
 * under, so its spend can be recomputed exactly later. Pure: no clock, no IO.
 *
 * Real model prices come from the operator, never from memory (BE lead,
 * 2026-10-13). Every table ever current stays here, under its version, so a
 * dispatch started under an older one still prices.
 */

/** US dollars per million tokens, at most six decimal places. */
export type ModelPrice = {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok: number;
	cacheWritePerMTok: number;
};

export type PriceTable = Readonly<Record<string, ModelPrice>>;

const FAKE_HARNESS_PRICE: ModelPrice = {
	inputPerMTok: 0,
	outputPerMTok: 0,
	cacheReadPerMTok: 0,
	cacheWritePerMTok: 0,
};

/**
 * Every price table by version, oldest first. Append a new version when any
 * price changes; never edit one a dispatch may have started under.
 *
 * prices-2026-10-14: claude-sonnet-5-5 as J chose it for dispatches, checked
 * against platform.claude.com/docs/en/about-claude/pricing on 2026-10-14:
 * $2 input, $10 output, $0.10 cache hits, $2.50 5-minute and $4 1-hour cache
 * writes. A dispatch's split has one cache-write count, so it is priced at
 * the 1-hour rate: spend may read high, never low.
 */
export const PRICE_TABLES: Readonly<Record<string, PriceTable>> = {
	"prices-2026-10-13": { "fake-harness": FAKE_HARNESS_PRICE },
	"prices-2026-10-14": {
		"fake-harness": FAKE_HARNESS_PRICE,
		"claude-sonnet-5-5": {
			inputPerMTok: 2,
			outputPerMTok: 10,
			cacheReadPerMTok: 0.1,
			cacheWritePerMTok: 4,
		},
	},
};

/** The version a new dispatch starts under. Stored as dispatch.price_version. */
export const PRICE_VERSION = "prices-2026-10-14";

/** The current table. */
export const PRICES: PriceTable = PRICE_TABLES[PRICE_VERSION] as PriceTable;

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
