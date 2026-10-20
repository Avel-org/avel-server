import type { KnowledgeChunk } from "./knowledge";
import { parseSource } from "./search-results";

/** The two fields of a `search_result_location` citation this check reads. */
export type CanonCitation = { source: string; cited_text: string };

export type CitationCheck = {
	index: number;
	source: string;
	status: "ok" | "unknown_chunk" | "quote_not_found";
};

const lf = (s: string) => s.replace(/\r\n?/g, "\n");

/**
 * Whether each citation names a chunk that exists (by file and chunk id) and
 * quotes it. The quote must appear verbatim in the chunk's text: line endings
 * are the only thing normalized, and an empty quote names nothing. One
 * answer per citation, in order.
 */
export function validateCitations(
	citations: readonly CanonCitation[],
	chunks: readonly KnowledgeChunk[],
): CitationCheck[] {
	const byKey = new Map<string, KnowledgeChunk>();
	for (const c of chunks) byKey.set(`${c.fileId}\0${c.chunkId}`, c);
	return citations.map((citation, index) => {
		const named = parseSource(citation.source);
		const chunk = named
			? byKey.get(`${named.fileId}\0${named.chunkId}`)
			: undefined;
		const status: CitationCheck["status"] = !chunk
			? "unknown_chunk"
			: citation.cited_text !== "" &&
					lf(chunk.text).includes(lf(citation.cited_text))
				? "ok"
				: "quote_not_found";
		return { index, source: citation.source, status };
	});
}
