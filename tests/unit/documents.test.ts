import { describe, expect, it } from "vitest";
import {
	DOCX_MAX_INFLATED_BYTES,
	DOCX_MIME,
	documentText,
	PDF_MIME,
	sniffDocument,
	zipDirectory,
} from "../../src/lib/documents";
import { docxOf, pdfOf, zipOf } from "./document-fixtures";

describe("sniffDocument", () => {
	it("knows a PDF and a docx from their bytes, whatever they are called", () => {
		expect(sniffDocument(pdfOf(["Brief"]))).toBe(PDF_MIME);
		expect(sniffDocument(docxOf(["Brief"]))).toBe(DOCX_MIME);
	});

	it("refuses a legacy .doc, a zip that is not a docx, text and nothing", () => {
		const ole = new Uint8Array([
			0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
		]);
		expect(sniffDocument(ole)).toBeNull();
		expect(sniffDocument(zipOf({ "readme.txt": "hi" }))).toBeNull();
		expect(sniffDocument(new TextEncoder().encode("# Brief"))).toBeNull();
		expect(sniffDocument(new Uint8Array())).toBeNull();
		// A zip's magic with no directory behind it.
		expect(
			sniffDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])),
		).toBeNull();
	});
});

describe("zipDirectory", () => {
	it("reads every name and the inflated sizes the directory states", () => {
		const dir = zipDirectory(zipOf({ a: "12345", "b/c.xml": "123" }));
		expect(dir).toMatchObject({ names: ["a", "b/c.xml"], inflatedBytes: 8 });
	});
});

describe("documentText", () => {
	it("reads a PDF's pages in order, a blank line between them", async () => {
		expect(
			await documentText(pdfOf(["Booking brief", "Second page"]), PDF_MIME),
		).toEqual({
			text: "Booking brief\n\nSecond page",
		});
	});

	it("refuses a PDF with no text layer, as a scan is", async () => {
		expect(await documentText(pdfOf([null, null]), PDF_MIME)).toEqual({
			refused:
				"The PDF has no text layer; a scan needs its text before Canon can read it",
		});
	});

	it("refuses an encrypted PDF", async () => {
		expect(
			await documentText(pdfOf(["Secret"], { encrypted: true }), PDF_MIME),
		).toEqual({
			refused: "The PDF is encrypted; upload it without a password",
		});
	});

	it("refuses a PDF that does not parse", async () => {
		const broken = new TextEncoder().encode("%PDF-1.4\nnothing else");
		expect(await documentText(broken, PDF_MIME)).toEqual({
			refused: "The PDF could not be read",
		});
	});

	it("reads a docx's paragraphs", async () => {
		expect(
			await documentText(docxOf(["Scope", "Three booking flows."]), DOCX_MIME),
		).toEqual({ text: "Scope\n\nThree booking flows." });
	});

	it("refuses a docx whose directory claims more than the cap, before inflating it", async () => {
		const bomb = docxOf(["x"], { claimInflated: DOCX_MAX_INFLATED_BYTES + 1 });
		expect(await documentText(bomb, DOCX_MIME)).toEqual({
			refused: "The Word file is too large once unpacked",
		});
	});

	it("reads a docx whose entries are deflated, as Word writes them", async () => {
		expect(
			await documentText(docxOf(["Scope"], { deflate: true }), DOCX_MIME),
		).toEqual({ text: "Scope" });
	});

	it("refuses a docx whose directory lies about its size, by inflating it against the cap", async () => {
		// 60 MiB of spaces deflate to about 60 KiB; the directory claims 100 bytes.
		const liar = docxOf(["x"], {
			deflate: true,
			padding: 60 * 1024 * 1024,
			claimInflated: 100,
		});
		expect(liar.length).toBeLessThan(1024 * 1024);
		expect(await documentText(liar, DOCX_MIME)).toEqual({
			refused: "The Word file is too large once unpacked",
		});
	});

	it("refuses an empty docx and one that does not parse", async () => {
		expect(await documentText(docxOf([]), DOCX_MIME)).toEqual({
			refused: "The Word file has no text",
		});
		expect(
			await documentText(zipOf({ "word/document.xml": "<not xml" }), DOCX_MIME),
		).toEqual({ refused: "The Word file could not be read" });
	});
});
