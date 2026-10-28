import { z } from "zod";

/**
 * Lists page by cursor. The cursor is opaque to clients: the server encodes
 * the position of the last item it returned, and the client sends it back
 * unchanged. A null `nextCursor` means there is no next page.
 *
 * Cursor, not offset: an offset shifts when rows are inserted or deleted
 * between requests, so a page can repeat or skip items.
 */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const pageQuery = z.object({
	cursor: z.string().min(1).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_PAGE_SIZE)
		.default(DEFAULT_PAGE_SIZE),
});

export type PageQuery = z.infer<typeof pageQuery>;

export const pageMeta = z.object({
	nextCursor: z.string().nullable(),
	/**
	 * The exact number of rows the list's filters match, the same on every
	 * page (the cursor does not narrow it). Optional: a route where an exact
	 * count is expensive omits it.
	 */
	total: z.number().int().nonnegative().optional(),
});

export type PageMeta = z.infer<typeof pageMeta>;

/** The success envelope for a list route: data is an array, meta is required. */
export function pageEnvelope<T extends z.ZodTypeAny>(item: T) {
	return z.object({
		success: z.literal(true),
		data: z.array(item),
		meta: pageMeta,
	});
}

/** A list envelope. Given a total, the meta keeps it as a number, for a contract that requires one. */
export function page<T>(
	items: T[],
	nextCursor: string | null,
	total: number,
): {
	success: true;
	data: T[];
	meta: { nextCursor: string | null; total: number };
};
export function page<T>(
	items: T[],
	nextCursor: string | null,
	total?: number,
): { success: true; data: T[]; meta: PageMeta };
export function page<T>(
	items: T[],
	nextCursor: string | null,
	total?: number,
): { success: true; data: T[]; meta: PageMeta } {
	return {
		success: true,
		data: items,
		meta: total === undefined ? { nextCursor } : { nextCursor, total },
	};
}
