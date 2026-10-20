/**
 * The most characters (UTF-16 code units) one chunk holds before its section
 * is split at paragraph boundaries. [hypothesis]: sized so a citation names a
 * passage, not a document. Changing it moves chunk boundaries, and so chunk
 * ids, for any section it newly splits or joins.
 */
export const CHUNK_MAX_CHARS = 4000;

/** Bump with any change to where splitKnowledge draws a boundary. */
export const SPLITTER_VERSION = 1;

/**
 * Which rules made a set of chunk ids. A chunk id is stable only under the
 * same rules, so store this beside any id that is kept.
 */
export const KNOWLEDGE_SPLIT_VERSION = `split-${SPLITTER_VERSION}/max-${CHUNK_MAX_CHARS}`;

/** One uploaded Markdown file. `sha256` is the hash of its stored bytes. */
export type KnowledgeFile = {
	fileId: string;
	sha256: string;
	name: string;
	contentMd: string;
};

/** One passage Canon can cite. */
export type KnowledgeChunk = {
	/** `<sha256>:<startLine>-<endLine>`: the same bytes always give the same ids. */
	chunkId: string;
	fileId: string;
	sha256: string;
	/** The file's name, for the search result's title. */
	name: string;
	/** The headings above and including this chunk's own; empty for the root. */
	headingPath: string[];
	/** Exactly lines startLine..endLine, joined with LF. */
	text: string;
	/** 1-based, after CRLF and CR are read as LF. */
	startLine: number;
	endLine: number;
};

const SHA256 = /^[0-9a-f]{64}$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

type Fence = { char: string; length: number };

/**
 * Splits Markdown into citable chunks: one per section, a section running
 * from an ATX heading to the next. Pure, and in file order, then position.
 *
 * - Fenced code (``` or ~~~) is opaque: nothing inside it is a heading or a
 *   paragraph boundary. An unclosed fence runs to the end of the file.
 * - Front matter (`---` on line 1, up to the next `---` or `...`) belongs to
 *   the root chunk, the text before the first heading.
 * - A section over CHUNK_MAX_CHARS splits at blank lines outside fences. A
 *   single paragraph over the cap stays whole.
 * - Blank lines at a chunk's edges are left out, and a chunk with nothing in
 *   it is dropped. Setext headings are not split on.
 */
export function splitKnowledge(
	files: readonly KnowledgeFile[],
): KnowledgeChunk[] {
	const seen = new Set<string>();
	const chunks: KnowledgeChunk[] = [];
	for (const file of files) {
		if (seen.has(file.fileId)) {
			throw new Error(`File ${file.fileId} is listed more than once`);
		}
		seen.add(file.fileId);
		if (!SHA256.test(file.sha256)) {
			throw new Error(`File ${file.fileId} has sha256 ${file.sha256}`);
		}
		chunks.push(...splitFile(file));
	}
	return chunks;
}

function splitFile(file: KnowledgeFile): KnowledgeChunk[] {
	const lines = file.contentMd.replace(/\r\n?/g, "\n").split("\n");
	const sections: Array<{ start: number; end: number; path: string[] }> = [];
	const stack: Array<{ level: number; title: string }> = [];
	let start = 0;
	let fence: Fence | null = null;

	const bodyFrom = frontMatterEnd(lines) + 1;
	for (let i = bodyFrom; i < lines.length; i++) {
		const line = lines[i] as string;
		if (fence) {
			if (closes(line, fence)) fence = null;
			continue;
		}
		fence = opens(line);
		if (fence) continue;
		const heading = ATX.exec(line);
		if (!heading) continue;
		const level = (heading[1] as string).length;
		sections.push({ start, end: i - 1, path: stack.map((h) => h.title) });
		while (
			stack.length > 0 &&
			(stack.at(-1) as { level: number }).level >= level
		) {
			stack.pop();
		}
		stack.push({ level, title: titleOf(heading[2] ?? "") });
		start = i;
	}
	sections.push({
		start,
		end: lines.length - 1,
		path: stack.map((h) => h.title),
	});

	const chunks: KnowledgeChunk[] = [];
	for (const s of sections) {
		for (const [from, to] of pack(lines, s.start, s.end)) {
			chunks.push({
				chunkId: `${file.sha256}:${from + 1}-${to + 1}`,
				fileId: file.fileId,
				sha256: file.sha256,
				name: file.name,
				headingPath: s.path,
				text: lines.slice(from, to + 1).join("\n"),
				startLine: from + 1,
				endLine: to + 1,
			});
		}
	}
	return chunks;
}

/** The 0-based index of the closing front matter line, or -1 when there is none. */
function frontMatterEnd(lines: readonly string[]): number {
	if (lines[0]?.trimEnd() !== "---") return -1;
	for (let i = 1; i < lines.length; i++) {
		const l = (lines[i] as string).trimEnd();
		if (l === "---" || l === "...") return i;
	}
	return -1;
}

function opens(line: string): Fence | null {
	const m = FENCE_OPEN.exec(line);
	if (!m) return null;
	const marker = m[1] as string;
	// A backtick fence's info string may not hold a backtick (CommonMark).
	if (marker[0] === "`" && (m[2] as string).includes("`")) return null;
	return { char: marker[0] as string, length: marker.length };
}

function closes(line: string, fence: Fence): boolean {
	const m = FENCE_CLOSE.exec(line);
	if (!m) return false;
	const marker = m[1] as string;
	return marker[0] === fence.char && marker.length >= fence.length;
}

/** A heading's text, without its optional closing run of #. */
function titleOf(raw: string): string {
	const t = raw.trim();
	if (/^#+$/.test(t)) return "";
	return t.replace(/[ \t]+#+$/, "").trim();
}

/**
 * The [from, to] line ranges (0-based, inclusive) of one section's chunks:
 * paragraphs packed greedily up to the cap, blank edges trimmed.
 */
function pack(
	lines: readonly string[],
	start: number,
	end: number,
): Array<[number, number]> {
	// Paragraphs: runs of lines between blank lines, where a fence's blank
	// lines belong to the fence.
	const paragraphs: Array<[number, number]> = [];
	let fence: Fence | null = null;
	let open = -1;
	for (let i = start; i <= end; i++) {
		const line = lines[i] as string;
		const blank = fence === null && line.trim() === "";
		if (fence) {
			if (closes(line, fence)) fence = null;
		} else {
			fence = opens(line);
		}
		if (blank) {
			if (open >= 0) paragraphs.push([open, i - 1]);
			open = -1;
		} else if (open < 0) {
			open = i;
		}
	}
	if (open >= 0) paragraphs.push([open, end]);

	const ranges: Array<[number, number]> = [];
	let current: [number, number] | null = null;
	for (const p of paragraphs) {
		if (current === null) {
			current = [p[0], p[1]];
			continue;
		}
		if (length(lines, current[0], p[1]) > CHUNK_MAX_CHARS) {
			ranges.push(current);
			current = [p[0], p[1]];
		} else {
			current[1] = p[1];
		}
	}
	if (current) ranges.push(current);
	return ranges;
}

/** The length of lines from..to joined with LF. */
function length(lines: readonly string[], from: number, to: number): number {
	let n = to - from;
	for (let i = from; i <= to; i++) n += (lines[i] as string).length;
	return n;
}
