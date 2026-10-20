import type { KnowledgeChunk } from "./knowledge";

/**
 * A Messages API `search_result` content block, as documented at
 * https://platform.claude.com/docs/en/build-with-claude/search-results
 * (read 2026-10-19). It mirrors SearchResultBlockParam in @anthropic-ai/sdk
 * 0.134.0, which this repository has only as the Agent SDK's dependency, so
 * the compiler does not check it against the SDK. [attestation]
 */
export type SearchResultBlock = {
	type: "search_result";
	/** Any stable string; returned unchanged on every citation of this block. */
	source: string;
	title: string;
	content: Array<{ type: "text"; text: string }>;
	/** The API refuses a request whose search results mix enabled and disabled. */
	citations: { enabled: boolean };
	cache_control?: { type: "ephemeral" };
};

const SOURCE = /^canon:\/\/([^/]+)\/([^/]+)$/;

/** `canon://<fileId>/<chunkId>`, each part URI-encoded. */
export function sourceFor(
	chunk: Pick<KnowledgeChunk, "fileId" | "chunkId">,
): string {
	return `canon://${encodeURIComponent(chunk.fileId)}/${encodeURIComponent(chunk.chunkId)}`;
}

/** The file and chunk a source names, or null when it is not one of ours. */
export function parseSource(
	source: string,
): { fileId: string; chunkId: string } | null {
	const m = SOURCE.exec(source);
	if (!m) return null;
	try {
		return {
			fileId: decodeURIComponent(m[1] as string),
			chunkId: decodeURIComponent(m[2] as string),
		};
	} catch {
		return null;
	}
}

/**
 * One search result per chunk, in chunk order. Each holds the chunk as a
 * single text block: Claude cites whole blocks, so a citation's cited_text
 * is then the chunk's text. Citations are on for every block. The last block
 * carries the cache breakpoint, so the whole set caches as one prefix.
 */
export function toSearchResultBlocks(
	chunks: readonly KnowledgeChunk[],
): SearchResultBlock[] {
	return chunks.map((c, i) => {
		const block: SearchResultBlock = {
			type: "search_result",
			source: sourceFor(c),
			title: [c.name, ...c.headingPath].join(" > "),
			content: [{ type: "text", text: c.text }],
			citations: { enabled: true },
		};
		if (i === chunks.length - 1) block.cache_control = { type: "ephemeral" };
		return block;
	});
}
