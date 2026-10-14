import { sha256Hex } from "./tokens";

/**
 * JSON with every object's keys sorted, at every depth, so two bodies that
 * differ only in key order serialize the same. Keys sort by UTF-16 code
 * unit, never by locale (docs/DEV-TIPS.md §2). Arrays keep their order.
 * Otherwise it is JSON.stringify: undefined object members are dropped and
 * toJSON is honoured. A body of undefined, as on a route with no body,
 * serializes as null.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sorted(value)) ?? "null";
}

function sorted(value: unknown): unknown {
	const plain =
		value !== null &&
		typeof value === "object" &&
		typeof (value as { toJSON?: unknown }).toJSON === "function"
			? (value as { toJSON: () => unknown }).toJSON()
			: value;
	if (Array.isArray(plain)) return plain.map(sorted);
	if (plain === null || typeof plain !== "object") return plain;
	const record = plain as Record<string, unknown>;
	// fromEntries defines each key as its own property, "__proto__" included.
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, sorted(record[key])]),
	);
}

/**
 * The hash stored beside an idempotency key (DATA-CONTRACTS-V2.md,
 * Idempotency): a retry with the same key and an equal body replays; any
 * other body under that key is 409 IDEMPOTENCY_REPLAY.
 */
export function requestSha256(body: unknown): string {
	return sha256Hex(canonicalJson(body));
}
