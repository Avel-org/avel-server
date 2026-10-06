/**
 * The only place in this codebase that creates identifiers.
 *
 * Production uses random UUIDs. Tests use sequential IDs, so output is
 * predictable and can be compared exactly. scripts/check-determinism.sh fails
 * the build if randomUUID() or Math.random() appears anywhere outside this file.
 */
export interface IdGenerator {
	next(): string;
}

export const randomIds: IdGenerator = {
	next: () => crypto.randomUUID(),
};

/**
 * 00000000-0000-4000-8000-000000000001, then ...0002, and so on. Valid UUIDs
 * (version 4, RFC 4122 variant), because ids land in uuid columns and in
 * contract fields validated as z.string().uuid().
 */
export function sequentialIds(): IdGenerator {
	let n = 0;
	return {
		next: () => {
			n += 1;
			return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		},
	};
}
