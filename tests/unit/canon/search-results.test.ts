import { describe, expect, it } from "vitest";
import {
	parseSource,
	sourceFor,
	splitKnowledge,
	toSearchResultBlocks,
	validateCitations,
} from "../../../src/lib/canon";

const SHA = "d".repeat(64);
const FILE = "0b1c2d3e-0000-4000-8000-000000000001";

const chunks = splitKnowledge([
	{
		fileId: FILE,
		sha256: SHA,
		name: "Salon brief.md",
		contentMd:
			"Root note.\n\n# Booking\nClients book a slot.\r\nNo double booking.\n## Rules\nOne per hour.",
	},
]);

describe("toSearchResultBlocks", () => {
	it("builds one search_result per chunk, one text block each, citations on", () => {
		const blocks = toSearchResultBlocks(chunks);
		expect(blocks).toHaveLength(3);
		expect(blocks[1]).toEqual({
			type: "search_result",
			source: sourceFor(chunks[1] as (typeof chunks)[number]),
			title: "Salon brief.md > Booking",
			content: [
				{
					type: "text",
					text: "# Booking\nClients book a slot.\nNo double booking.",
				},
			],
			citations: { enabled: true },
		});
		expect(blocks[0]?.title).toBe("Salon brief.md");
		expect(blocks[2]?.title).toBe("Salon brief.md > Booking > Rules");
	});

	it("enables citations on every block, since the API refuses a mix", () => {
		expect(toSearchResultBlocks(chunks).every((b) => b.citations.enabled)).toBe(
			true,
		);
	});

	it("marks only the last block as a cache breakpoint", () => {
		const blocks = toSearchResultBlocks(chunks);
		expect(blocks.map((b) => b.cache_control)).toEqual([
			undefined,
			undefined,
			{ type: "ephemeral" },
		]);
		expect(toSearchResultBlocks([])).toEqual([]);
	});

	it("encodes the file and chunk in a source that parses back", () => {
		const c = chunks[2] as (typeof chunks)[number];
		const source = sourceFor(c);
		expect(source).toBe(`canon://${FILE}/${encodeURIComponent(c.chunkId)}`);
		expect(parseSource(source)).toEqual({ fileId: FILE, chunkId: c.chunkId });
		const odd = { fileId: "a/b c", chunkId: `${SHA}:1-2` };
		expect(parseSource(sourceFor(odd))).toEqual(odd);
		for (const bad of [
			"",
			"https://x.y/z",
			"canon://only",
			"canon://a/b/c",
			"canon://%E0%A4%A/x",
		]) {
			expect(parseSource(bad), bad).toBeNull();
		}
	});
});

describe("validateCitations", () => {
	const at = (i: number) => sourceFor(chunks[i] as (typeof chunks)[number]);

	it("passes a citation whose text is in the chunk it names", () => {
		expect(
			validateCitations(
				[
					{
						source: at(1),
						cited_text: "# Booking\nClients book a slot.\nNo double booking.",
					},
					{ source: at(1), cited_text: "Clients book a slot." },
				],
				chunks,
			).map((c) => c.status),
		).toEqual(["ok", "ok"]);
	});

	it("matches across line endings only, never loosely", () => {
		const v = (cited_text: string) =>
			validateCitations([{ source: at(1), cited_text }], chunks)[0]?.status;
		expect(v("slot.\r\nNo double")).toBe("ok");
		expect(v("slot.\rNo double")).toBe("ok");
		expect(v("clients book a slot.")).toBe("quote_not_found");
		expect(v("Clients  book a slot.")).toBe("quote_not_found");
		expect(v("Clients book a slot. ")).toBe("quote_not_found");
		expect(v("One per hour.")).toBe("quote_not_found");
		expect(v("")).toBe("quote_not_found");
	});

	it("is unknown_chunk for a source that names nothing here", () => {
		const other = sourceFor({
			fileId: "other",
			chunkId: (chunks[1] as (typeof chunks)[number]).chunkId,
		});
		const missingLines = sourceFor({ fileId: FILE, chunkId: `${SHA}:99-100` });
		expect(
			validateCitations(
				[
					{ source: "https://example.com", cited_text: "Root note." },
					{ source: other, cited_text: "Root note." },
					{ source: missingLines, cited_text: "Root note." },
				],
				chunks,
			).map((c) => c.status),
		).toEqual(["unknown_chunk", "unknown_chunk", "unknown_chunk"]);
	});

	it("answers each citation in order, with its index and source", () => {
		const out = validateCitations(
			[
				{ source: at(0), cited_text: "Root note." },
				{ source: "nope", cited_text: "x" },
			],
			chunks,
		);
		expect(out).toEqual([
			{ index: 0, source: at(0), status: "ok" },
			{ index: 1, source: "nope", status: "unknown_chunk" },
		]);
	});
});
