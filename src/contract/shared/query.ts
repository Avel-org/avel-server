import { z } from "zod";

/**
 * A list filter that takes several values in either form: repeated
 * (?kind=a&kind=b) or indexed, as ts-rest's client sends it
 * (?kind[0]=a&kind[1]=b). Parses to an array either way.
 */
export function oneOrMany<T extends z.ZodTypeAny>(item: T) {
	return z
		.union([item, z.array(item)])
		.transform((v): z.output<T>[] => (Array.isArray(v) ? v : [v]));
}

/** Case-insensitive substring search, the same bounds as every other list's q. */
export const searchQuery = z.string().trim().min(1).max(200);
