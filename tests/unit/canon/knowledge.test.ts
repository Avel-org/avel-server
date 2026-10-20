import { describe, expect, it } from "vitest";
import {
	CHUNK_MAX_CHARS,
	KNOWLEDGE_SPLIT_VERSION,
	type KnowledgeChunk,
	SPLITTER_VERSION,
	splitKnowledge,
} from "../../../src/lib/canon";
import { rng } from "../gate/fixtures";

const SHA = "a".repeat(64);

const split = (
	contentMd: string,
	over: { fileId?: string; sha256?: string } = {},
) =>
	splitKnowledge([
		{
			fileId: over.fileId ?? "f1",
			sha256: over.sha256 ?? SHA,
			name: "brief.md",
			contentMd,
		},
	]);

const shape = (chunks: KnowledgeChunk[]) =>
	chunks.map((c) => [c.headingPath.join(" > "), c.startLine, c.endLine]);

const md = (...lines: string[]) => lines.join("\n");

describe("splitKnowledge", () => {
	it("names the rules that made its chunk ids: splitter version and cap", () => {
		expect(SPLITTER_VERSION).toBe(1);
		expect(KNOWLEDGE_SPLIT_VERSION).toBe(
			`split-${SPLITTER_VERSION}/max-${CHUNK_MAX_CHARS}`,
		);
		expect(KNOWLEDGE_SPLIT_VERSION).toBe("split-1/max-4000");
	});

	it("splits on ATX headings and nests the heading path by level", () => {
		const chunks = split(
			md(
				"Intro line.", // 1
				"", // 2
				"# Booking", // 3
				"Clients book slots.", // 4
				"## Rules", // 5
				"No double booking.", // 6
				"### Edge", // 7
				"Midnight.", // 8
				"## Calendar", // 9
				"Day view.", // 10
				"# Billing", // 11
				"Monthly.", // 12
			),
		);
		expect(shape(chunks)).toEqual([
			["", 1, 1],
			["Booking", 3, 4],
			["Booking > Rules", 5, 6],
			["Booking > Rules > Edge", 7, 8],
			["Booking > Calendar", 9, 10],
			["Billing", 11, 12],
		]);
		expect(chunks[1]).toMatchObject({
			chunkId: `${SHA}:3-4`,
			fileId: "f1",
			sha256: SHA,
			name: "brief.md",
			text: "# Booking\nClients book slots.",
		});
	});

	it("keeps a skipped level under its nearest parent, then pops back", () => {
		const chunks = split(md("# A", "x", "### C", "y", "## D", "z"));
		expect(chunks.map((c) => c.headingPath)).toEqual([
			["A"],
			["A", "C"],
			["A", "D"],
		]);
	});

	it("reads only real ATX headings", () => {
		const chunks = split(
			md(
				"# Top", // 1
				"#hashtag is text", // 2
				"####### seven is text", // 3
				"    # four spaces is code", // 4
				"   ## Three spaces ##", // 5
				"body", // 6
				"#", // 7
				"empty heading above", // 8
				"#\tTabbed", // 9
			),
		);
		expect(shape(chunks)).toEqual([
			["Top", 1, 4],
			["Top > Three spaces", 5, 6],
			// A bare # is a level-1 heading with no text: it replaces Top.
			["", 7, 8],
			["Tabbed", 9, 9],
		]);
		expect(chunks[2]?.headingPath).toEqual([""]);
	});

	it("treats fenced code as opaque, for ``` and ~~~, closing only on a matching fence", () => {
		const chunks = split(
			md(
				"# Code", // 1
				"```bash", // 2
				"# not a heading", // 3
				"~~~", // 4
				"## still not", // 5
				"````", // 6 longer closes
				"~~~~ python", // 7
				"# no", // 8
				"```", // 9 wrong char, stays open
				"~~~~", // 10
				"# After", // 11
				"text", // 12
			),
		);
		expect(shape(chunks)).toEqual([
			["Code", 1, 10],
			["After", 11, 12],
		]);
	});

	it("closes a fence only with one at least as long, and refuses a backtick in a backtick info string", () => {
		expect(
			shape(
				split(
					md("# A", "````", "# hidden", "```", "# still hidden", "````", "# B"),
				),
			),
		).toEqual([
			["A", 1, 6],
			["B", 7, 7],
		]);
		// "``` a`b" is not a fence (CommonMark), so the heading after it is real.
		expect(shape(split(md("# A", "``` a`b", "# B")))).toEqual([
			["A", 1, 2],
			["B", 3, 3],
		]);
	});

	it("runs an unclosed fence to the end of the file", () => {
		const chunks = split(md("# A", "```", "# hidden", "", "# also hidden"));
		expect(shape(chunks)).toEqual([["A", 1, 5]]);
	});

	it("puts front matter in the root chunk, comments and all", () => {
		const chunks = split(
			md(
				"---",
				"title: Salon",
				"# a yaml comment",
				"---",
				"",
				"# Scope",
				"All of it.",
			),
		);
		expect(shape(chunks)).toEqual([
			["", 1, 4],
			["Scope", 6, 7],
		]);
		expect(chunks[0]?.text).toBe("---\ntitle: Salon\n# a yaml comment\n---");
	});

	it("does not treat an unclosed --- as front matter", () => {
		const chunks = split(md("---", "# Real", "text"));
		expect(shape(chunks)).toEqual([
			["", 1, 1],
			["Real", 2, 3],
		]);
	});

	it("reads CRLF and CR the same as LF, with LF in the text", () => {
		const lf = split(md("# A", "one", "", "two"));
		expect(split("# A\r\none\r\n\r\ntwo")).toEqual(lf);
		expect(split("# A\rone\r\rtwo")).toEqual(lf);
		expect(lf[0]?.text).toBe("# A\none\n\ntwo");
	});

	it("leaves out blank lines at a chunk's edges and chunks with nothing in them", () => {
		const chunks = split(
			md("", "  ", "# A", "", "text", "", "", "# B", "", ""),
		);
		expect(shape(chunks)).toEqual([
			["A", 3, 5],
			["B", 8, 8],
		]);
	});

	it("splits an oversize section at blank lines, never inside a fence", () => {
		const para = (c: string) => c.repeat(CHUNK_MAX_CHARS * 0.4);
		const chunks = split(
			md(
				"# Big", // 1
				para("a"), // 2
				"", // 3
				para("b"), // 4
				"", // 5
				"```", // 6
				para("c"), // 7
				"", // 8 inside the fence: not a boundary
				para("d"), // 9
				"```", // 10
				"", // 11
				para("e"), // 12
			),
		);
		expect(shape(chunks)).toEqual([
			["Big", 1, 4],
			["Big", 6, 10],
			["Big", 12, 12],
		]);
		expect(chunks[0]?.chunkId).toBe(`${SHA}:1-4`);
	});

	it("keeps a fence whole even when its blank line would split an oversize section", () => {
		const big = (c: string) => c.repeat(CHUNK_MAX_CHARS * 0.6);
		expect(
			shape(split(md("# Big", "```", big("c"), "", big("d"), "```"))),
		).toEqual([["Big", 1, 6]]);
	});

	it("counts the line breaks a chunk's text holds against the cap", () => {
		const half = CHUNK_MAX_CHARS / 2;
		// Joined, these are exactly CHUNK_MAX_CHARS + 1 with their two LFs.
		expect(
			shape(split(md("a".repeat(half), "", "b".repeat(half - 1)))),
		).toEqual([
			["", 1, 1],
			["", 3, 3],
		]);
		// And exactly CHUNK_MAX_CHARS here, which still fits.
		expect(
			shape(split(md("a".repeat(half), "", "b".repeat(half - 2)))),
		).toEqual([["", 1, 3]]);
	});

	it("keeps a single paragraph larger than the cap whole", () => {
		const long = "z".repeat(CHUNK_MAX_CHARS * 2);
		const chunks = split(md("# Long", long));
		expect(shape(chunks)).toEqual([["Long", 1, 2]]);
	});

	it("gives identical bytes identical chunk ids, and keeps files apart by fileId", () => {
		const doc = md("# A", "x", "# B", "y");
		const [a, b] = [split(doc), split(doc)];
		expect(a.map((c) => c.chunkId)).toEqual(b.map((c) => c.chunkId));
		const both = splitKnowledge([
			{ fileId: "f1", sha256: SHA, name: "one.md", contentMd: doc },
			{ fileId: "f2", sha256: SHA, name: "two.md", contentMd: doc },
		]);
		expect(both.map((c) => `${c.fileId}|${c.chunkId}`)).toEqual([
			`f1|${SHA}:1-2`,
			`f1|${SHA}:3-4`,
			`f2|${SHA}:1-2`,
			`f2|${SHA}:3-4`,
		]);
	});

	it("follows file order, then position", () => {
		const out = splitKnowledge([
			{ fileId: "z", sha256: "b".repeat(64), name: "z.md", contentMd: "# Z" },
			{
				fileId: "a",
				sha256: "c".repeat(64),
				name: "a.md",
				contentMd: "# A1\n# A2",
			},
		]);
		expect(out.map((c) => `${c.fileId}:${c.startLine}`)).toEqual([
			"z:1",
			"a:1",
			"a:2",
		]);
	});

	it("refuses a file listed twice and a sha that is not 64 lowercase hex", () => {
		const f = { fileId: "f1", sha256: SHA, name: "a.md", contentMd: "# A" };
		expect(() => splitKnowledge([f, f])).toThrow(/more than once/);
		expect(() => splitKnowledge([{ ...f, sha256: "ABC" }])).toThrow(/sha256/);
	});

	it("property: every chunk is its exact lines, in order, covering every non-blank line once", () => {
		const pieces = [
			"# H1",
			"## H2",
			"### H3",
			"text line",
			"",
			"```",
			"# fenced",
			"~~~",
			"#tag",
			"x".repeat(CHUNK_MAX_CHARS / 3),
		];
		for (let seed = 1; seed <= 300; seed++) {
			const r = rng(seed);
			const lines = Array.from({ length: r.int(40) }, () => r.pick(pieces));
			const chunks = split(lines.join(r.pick(["\n", "\r\n"])));
			const covered = new Array<number>(lines.length).fill(0);
			let last = 0;
			for (const c of chunks) {
				expect(c.text, `seed ${seed}`).toBe(
					lines.slice(c.startLine - 1, c.endLine).join("\n"),
				);
				expect(c.startLine, `seed ${seed}`).toBeGreaterThan(last);
				expect(c.chunkId).toBe(`${SHA}:${c.startLine}-${c.endLine}`);
				last = c.endLine;
				for (let i = c.startLine - 1; i < c.endLine; i++)
					covered[i] = (covered[i] ?? 0) + 1;
			}
			lines.forEach((l, i) => {
				if (l.trim() !== "")
					expect(covered[i], `seed ${seed}, line ${i + 1}`).toBe(1);
			});
		}
	});
});
