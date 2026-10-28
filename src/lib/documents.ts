import mammoth from "mammoth";
import { extractText } from "unpdf";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type DocumentMime = typeof PDF_MIME | typeof DOCX_MIME;

/**
 * A docx's limits, read from its zip directory before anything inflates it:
 * a few megabytes of zip can claim gigabytes once inflated. A [hypothesis]
 * sized well above any brief: 50 MiB inflated, 2000 entries. The sizes are
 * the directory's claim: a zip that lies is inflated in full by mammoth.
 * [attestation], on an upload only the operator can make.
 */
export const DOCX_MAX_INFLATED_BYTES = 50 * 1024 * 1024;
export const DOCX_MAX_ENTRIES = 2000;

/**
 * Which document the bytes are, from the bytes alone: a PDF opens with
 * `%PDF-`; a docx is a zip whose directory holds `word/document.xml`. A
 * legacy .doc, any other zip and anything else is null.
 */
export function sniffDocument(bytes: Uint8Array): DocumentMime | null {
	if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return PDF_MIME;
	if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return null;
	const dir = zipDirectory(bytes);
	return dir?.names.includes("word/document.xml") ? DOCX_MIME : null;
}

/**
 * The document's text, or why it has none to give. A PDF's pages are joined
 * by a blank line. Refused: an encrypted PDF, a PDF with no text layer (a
 * scan), a docx past its limits, and anything that does not parse.
 */
export async function documentText(
	bytes: Uint8Array,
	mime: DocumentMime,
): Promise<{ text: string } | { refused: string }> {
	const result =
		mime === PDF_MIME ? await pdfText(bytes) : await docxText(bytes);
	if ("refused" in result) return result;
	const text = result.text.replace(/\r\n?/g, "\n").trim();
	if (text === "") {
		return {
			refused:
				mime === PDF_MIME
					? "The PDF has no text layer; a scan needs its text before Canon can read it"
					: "The Word file has no text",
		};
	}
	return { text };
}

async function pdfText(
	bytes: Uint8Array,
): Promise<{ text: string } | { refused: string }> {
	try {
		// pdf.js takes ownership of the buffer it is given, so it gets a copy.
		const { text } = await extractText(new Uint8Array(bytes), {
			mergePages: false,
		});
		return { text: text.map((page) => page.trim()).join("\n\n") };
	} catch (err) {
		if (err instanceof Error && err.name === "PasswordException") {
			return { refused: "The PDF is encrypted; upload it without a password" };
		}
		return { refused: "The PDF could not be read" };
	}
}

async function docxText(
	bytes: Uint8Array,
): Promise<{ text: string } | { refused: string }> {
	const dir = zipDirectory(bytes);
	if (!dir) return { refused: "The Word file could not be read" };
	if (
		dir.names.length > DOCX_MAX_ENTRIES ||
		dir.inflatedBytes > DOCX_MAX_INFLATED_BYTES
	) {
		return { refused: "The Word file is too large once unpacked" };
	}
	try {
		const { value } = await mammoth.extractRawText({
			buffer: Buffer.from(bytes),
		});
		return { text: value };
	} catch {
		return { refused: "The Word file could not be read" };
	}
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
	return magic.every((b, i) => bytes[i] === b);
}

/**
 * A zip's central directory: every entry's name and the sum of their
 * inflated sizes, as the directory states them. Null when there is no
 * well-formed directory. Zip64 archives are null too: no docx needs one.
 */
export function zipDirectory(
	bytes: Uint8Array,
): { names: string[]; inflatedBytes: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// The end-of-directory record is the last 22 bytes plus a comment of up
	// to 65535 bytes; search backwards for its signature.
	const floor = Math.max(0, bytes.length - 22 - 0xffff);
	let end = -1;
	for (let i = bytes.length - 22; i >= floor; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) return null;
	const count = view.getUint16(end + 10, true);
	const size = view.getUint32(end + 12, true);
	const offset = view.getUint32(end + 16, true);
	if (count === 0xffff || offset === 0xffffffff || offset + size > end) {
		return null;
	}
	const names: string[] = [];
	let inflatedBytes = 0;
	let at = offset;
	const decoder = new TextDecoder();
	for (let n = 0; n < count; n++) {
		if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return null;
		const inflated = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		if (inflated === 0xffffffff) return null;
		const nameEnd = at + 46 + nameLength;
		if (nameEnd > end) return null;
		names.push(decoder.decode(bytes.subarray(at + 46, nameEnd)));
		inflatedBytes += inflated;
		at = nameEnd + extraLength + commentLength;
	}
	return { names, inflatedBytes };
}
