import type { BriefSource } from "../contract/intake";
import { parseSource } from "./canon/search-results";

export type SourceIssue = { path: Array<string | number>; message: string };

const LISTS = ["requirements", "acceptanceCriteria"] as const;
export type SourceList = (typeof LISTS)[number];

type Item = Record<string, unknown>;

function itemsOf(brief: unknown, list: string): unknown[] {
	if (typeof brief !== "object" || brief === null) return [];
	const items = (brief as Item)[list];
	return Array.isArray(items) ? items : [];
}

function sourcesOf(item: unknown): unknown[] {
	if (typeof item !== "object" || item === null) return [];
	const sources = (item as Item).sources;
	return Array.isArray(sources) ? sources : [];
}

/** A source's chunk id, whether written bare or as `{ chunkId }`; else null. */
function chunkIdIn(source: unknown): string | null {
	if (typeof source === "string") return source;
	if (typeof source === "object" && source !== null) {
		const c = (source as Item).chunkId;
		return typeof c === "string" ? c : null;
	}
	return null;
}

/**
 * Every source on a brief's requirements and criteria that `known` does not
 * accept, one issue each, under `prefix`. A route passes the intake's own
 * file hashes; Canon's tool passes the chunk ids it was shown this turn. A
 * source nobody checked could name a file the intake never had, and the
 * reads that resolve a chunk to its file treat that as a broken invariant.
 * Any shape is read, since Canon's draft is checked against the brief schema
 * only after it is saved: what is not a source is the schema's to report.
 */
export function briefSourceIssues(
	brief: unknown,
	known: (chunkId: string) => boolean,
	prefix: Array<string | number>,
): SourceIssue[] {
	const issues: SourceIssue[] = [];
	for (const list of LISTS) {
		itemsOf(brief, list).forEach((item, i) => {
			sourcesOf(item).forEach((source, j) => {
				const chunkId = chunkIdIn(source);
				if (chunkId !== null && !known(chunkId)) {
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

/** Whether a chunk id's file, its sha256 prefix, is one of `shas`. */
export function inFiles(shas: ReadonlySet<string>) {
	return (chunkId: string) => shas.has(chunkId.split(":")[0] ?? "");
}

/**
 * Canon's draft with each source as `{ chunkId, confirmed: null }`. Canon
 * sees search results' sources, `canon://<fileId>/<chunkId>`, and copies
 * them, or writes a bare chunk id; the brief stores the chunk id. Anything
 * that is not a source is left as it is, for the schema to report.
 */
export function withChunkIds<T>(brief: T): T {
	return mapItems(brief, (item) =>
		Array.isArray(item.sources)
			? {
					...item,
					sources: (item.sources as unknown[]).map((s) => {
						const raw = chunkIdIn(s);
						if (raw === null) return s;
						return {
							chunkId: parseSource(raw)?.chunkId ?? raw,
							confirmed: null,
						};
					}),
				}
			: item,
	);
}

/**
 * `next` with every source's `confirmed` taken from `previous`, never from
 * the writer: a client or Canon cannot confirm a passage by writing the brief.
 * A source keeps its confirmation only while its item, matched by id in the
 * same list, keeps the same text and still cites it; anything else is null.
 */
export function carryConfirmations<T>(previous: unknown, next: T): T {
	const kept = new Map<string, BriefSource["confirmed"]>();
	for (const list of LISTS) {
		for (const item of itemsOf(previous, list)) {
			if (typeof item !== "object" || item === null) continue;
			const { id, text } = item as Item;
			for (const s of sourcesOf(item)) {
				const chunkId = chunkIdIn(s);
				const confirmed = (s as Item | null)?.confirmed;
				if (chunkId !== null && confirmed) {
					kept.set(
						JSON.stringify([list, id, text, chunkId]),
						confirmed as BriefSource["confirmed"],
					);
				}
			}
		}
	}
	return mapItems(next, (item, list) =>
		Array.isArray(item.sources)
			? {
					...item,
					sources: (item.sources as unknown[]).map((s) => {
						const chunkId = chunkIdIn(s);
						if (chunkId === null) return s;
						return {
							chunkId,
							confirmed:
								kept.get(JSON.stringify([list, item.id, item.text, chunkId])) ??
								null,
						};
					}),
				}
			: item,
	);
}

export type SourceDecision = {
	list: SourceList;
	itemId: string;
	chunkId: string;
	decision: "confirm" | "reject";
};

/**
 * The brief with each decision applied: a confirm stamps the source with who
 * and when, a reject removes it. A decision naming no source on that item is
 * an issue at its index in `decisions`, and then nothing is applied.
 */
export function applyDecisions<T>(
	brief: T,
	decisions: readonly SourceDecision[],
	confirmed: NonNullable<BriefSource["confirmed"]>,
): { brief: T; issues: SourceIssue[] } {
	const issues: SourceIssue[] = [];
	decisions.forEach((d, i) => {
		const item = itemsOf(brief, d.list).find(
			(it) => (it as Item | null)?.id === d.itemId,
		);
		if (!sourcesOf(item).some((s) => chunkIdIn(s) === d.chunkId)) {
			issues.push({
				path: ["decisions", i],
				message: `${d.list} ${d.itemId} does not cite ${d.chunkId}`,
			});
		}
	});
	if (issues.length > 0) return { brief, issues };
	const byKey = new Map(
		decisions.map((d) => [JSON.stringify([d.list, d.itemId, d.chunkId]), d]),
	);
	const next = mapItems(brief, (item, list) => ({
		...item,
		sources: sourcesOf(item).flatMap((s) => {
			const chunkId = chunkIdIn(s);
			const d = byKey.get(JSON.stringify([list, item.id, chunkId]));
			if (!d) return [s];
			return d.decision === "reject" ? [] : [{ chunkId, confirmed }];
		}),
	}));
	return { brief: next, issues };
}

/** Every source the operator has not confirmed, for approval to refuse. */
export function unconfirmedIssues(
	brief: unknown,
	prefix: Array<string | number>,
): SourceIssue[] {
	const issues: SourceIssue[] = [];
	for (const list of LISTS) {
		itemsOf(brief, list).forEach((item, i) => {
			sourcesOf(item).forEach((s, j) => {
				if (!(s as Item | null)?.confirmed) {
					issues.push({
						path: [...prefix, list, i, "sources", j],
						message: `${(item as Item).id} cites ${chunkIdIn(s)}, which no operator has confirmed`,
					});
				}
			});
		});
	}
	return issues;
}

function mapItems<T>(brief: T, f: (item: Item, list: SourceList) => Item): T {
	if (typeof brief !== "object" || brief === null) return brief;
	const out: Item = { ...(brief as Item) };
	for (const list of LISTS) {
		const items = out[list];
		if (!Array.isArray(items)) continue;
		out[list] = items.map((item) =>
			typeof item === "object" && item !== null ? f(item as Item, list) : item,
		);
	}
	return out as T;
}
