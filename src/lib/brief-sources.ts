import { parseSource } from "./canon/search-results";

export type SourceIssue = { path: Array<string | number>; message: string };

/**
 * Every source on a brief's requirements and criteria that `known` does not
 * accept, one issue each, under `prefix`. A route passes the intake's own
 * file hashes; Canon's tool passes the chunk ids it was shown this turn. A
 * source nobody checked could name a file the intake never had, and the
 * reads that resolve a chunk to its file treat that as a broken invariant.
 * Any shape is read, since Canon's draft is checked against the brief schema
 * only after it is saved: what is not a list of strings is the schema's to
 * report, not this.
 */
export function briefSourceIssues(
	brief: unknown,
	known: (chunkId: string) => boolean,
	prefix: Array<string | number>,
): SourceIssue[] {
	const issues: SourceIssue[] = [];
	for (const list of ["requirements", "acceptanceCriteria"] as const) {
		itemsOf(brief, list).forEach((item, i) => {
			sourcesOf(item).forEach((chunkId, j) => {
				if (typeof chunkId === "string" && !known(chunkId)) {
					issues.push({
						path: [...prefix, list, i, "sources", j],
						message: `${chunkId} is not a passage of this intake's files`,
					});
				}
			});
		});
	}
	return issues;
}

function itemsOf(brief: unknown, list: string): unknown[] {
	if (typeof brief !== "object" || brief === null) return [];
	const items = (brief as Record<string, unknown>)[list];
	return Array.isArray(items) ? items : [];
}

function sourcesOf(item: unknown): unknown[] {
	if (typeof item !== "object" || item === null) return [];
	const sources = (item as Record<string, unknown>).sources;
	return Array.isArray(sources) ? sources : [];
}

/**
 * The brief with each source written as a search result's source,
 * `canon://<fileId>/<chunkId>`, rewritten to its chunk id. Canon sees the
 * sources, not bare chunk ids, and copies them; the brief stores chunk ids.
 * Anything else is left as it is.
 */
export function withChunkIds<T>(brief: T): T {
	if (typeof brief !== "object" || brief === null) return brief;
	const out: Record<string, unknown> = {
		...(brief as Record<string, unknown>),
	};
	for (const list of ["requirements", "acceptanceCriteria"]) {
		const items = out[list];
		if (!Array.isArray(items)) continue;
		out[list] = items.map((item) =>
			typeof item === "object" &&
			item !== null &&
			Array.isArray((item as Record<string, unknown>).sources)
				? {
						...(item as Record<string, unknown>),
						sources: (
							(item as Record<string, unknown>).sources as unknown[]
						).map(chunkIdOf),
					}
				: item,
		);
	}
	return out as T;
}

/** Whether a chunk id's file, its sha256 prefix, is one of `shas`. */
export function inFiles(shas: ReadonlySet<string>) {
	return (chunkId: string) => shas.has(chunkId.split(":")[0] ?? "");
}

/** A search result's source as its chunk id; anything else unchanged. */
function chunkIdOf(value: unknown): unknown {
	return typeof value === "string"
		? (parseSource(value)?.chunkId ?? value)
		: value;
}
