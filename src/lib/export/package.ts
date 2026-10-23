import { createHash } from "node:crypto";
import { gitBlobSha } from "./blob";
import { byCodepoint } from "./order";
import type { PackageFile, PackageRead } from "./read";
import { refuse } from "./refusal";
import type { ZipEntry } from "./zip";

/** Where the gate receipt sits in the package. */
export const RECEIPT_PATH = ".avel/receipt.json";

/**
 * Where a zip lists the paths the package deletes (J, 2026-10-21). A zip
 * cannot delete, so it carries the list; a GitHub delivery deletes them
 * and carries no list.
 */
export const DELETES_PATH = ".avel/deletes.json";

/**
 * Where each dispatch's brief sits in the package (J, 2026-10-22): one file
 * per complete dispatch the integration commit was built from, at
 * .avel/dispatches/<dispatch id>.md, holding the brief frozen at start byte
 * for byte. Its sha256 is the dispatch's brief_sha256, so a reader can check
 * it. The identity is not shipped: it holds AVEL's role text.
 */
export const DISPATCH_BRIEFS_DIR = ".avel/dispatches/";

/** A dispatch's frozen brief, as the package ships it. */
export type DispatchBrief = { dispatchId: string; briefMd: string };

/** Where one dispatch's brief sits in the package. */
export const dispatchBriefPath = (dispatchId: string) =>
	`${DISPATCH_BRIEFS_DIR}${dispatchId}.md`;

/**
 * The package (module 10, decided 2026-10-21): the files the gate's
 * integration commit changed from the mission's base, with their modes,
 * plus the gate receipt at .avel/receipt.json and each complete
 * dispatch's brief under .avel/dispatches/, and the paths the commit
 * deleted. Files and deletes are each sorted by codepoint.
 */
export type RenderedPackage = { files: PackageFile[]; deletes: string[] };

/**
 * The package from what readPackage read, the receipt's exact string and
 * the dispatches' briefs. Pure. The receipt and each brief are added as
 * 100644 files of their strings' UTF-8 bytes. Refused (ExportRefused) when
 * the integration commit itself wrote or deleted .avel/receipt.json,
 * .avel/deletes.json or anything under .avel/dispatches/, because the
 * package's own would replace it.
 */
export function renderPackage(input: {
	read: PackageRead;
	receipt: string;
	briefs: readonly DispatchBrief[];
}): RenderedPackage {
	const { read } = input;
	if (
		read.files.some((f) => f.path === RECEIPT_PATH) ||
		read.deletes.includes(RECEIPT_PATH)
	) {
		throw refuse("The integration commit changed the receipt's path", {
			reason: "receipt_path_written",
			path: RECEIPT_PATH,
		});
	}
	if (
		read.files.some((f) => f.path === DELETES_PATH) ||
		read.deletes.includes(DELETES_PATH)
	) {
		throw refuse("The integration commit changed the deletes list's path", {
			reason: "deletes_path_written",
			path: DELETES_PATH,
		});
	}
	const written = [...read.files.map((f) => f.path), ...read.deletes].find(
		(p) => p.startsWith(DISPATCH_BRIEFS_DIR),
	);
	if (written !== undefined) {
		throw refuse("The integration commit changed a dispatch brief's path", {
			reason: "dispatch_brief_path_written",
			path: written,
		});
	}
	const briefs = input.briefs.map((b) =>
		textFile(dispatchBriefPath(b.dispatchId), b.briefMd),
	);
	if (new Set(briefs.map((b) => b.path)).size !== briefs.length) {
		throw new Error("The package lists one dispatch's brief twice");
	}
	return {
		files: [
			...read.files,
			textFile(RECEIPT_PATH, input.receipt),
			...briefs,
		].sort((a, b) => byCodepoint(a.path, b.path)),
		deletes: [...read.deletes].sort(byCodepoint),
	};
}

function textFile(path: string, text: string): PackageFile {
	const bytes = new TextEncoder().encode(text);
	return { path, mode: "100644", bytes, blobSha: gitBlobSha(bytes) };
}

/**
 * Bumped whenever the same package could give a different packageSha256.
 * An export records it beside the hash (EXPORT-ENGINE.md §13), so changing
 * the definition never makes an earlier export's hash unreproducible.
 */
export const PACKAGE_HASH_VERSION = 1;

/**
 * One sha256, as lowercase hex, over these bytes, in this order:
 *
 *   "avel-package-hash\0" "1\0"
 *   for each file, by path in codepoint order, .avel/receipt.json left out:
 *     "file\0" <mode> "\0" <blob sha> "\0" <path> "\0"
 *   for each deleted path, in codepoint order:
 *     "delete\0" <path> "\0"
 *
 * Every string is its UTF-8 bytes. <mode> is "100644" or "100755"; <blob
 * sha> is 40 lowercase hex, git's blob sha of the file's bytes. No field
 * can hold a NUL (git paths cannot), so the encoding is unambiguous.
 *
 * The receipt is left out, so the hash is the work's alone: the same
 * changes hash the same whichever gate run they carry. The dispatch briefs
 * are in it, because they belong to the dispatches the changes came from. Each file's
 * blob sha is recomputed from its bytes and must equal the one it carries,
 * so the hash is over the bytes and not over a claim about them.
 */
export function packageSha256(pkg: RenderedPackage): string {
	const files = pkg.files
		.filter((f) => f.path !== RECEIPT_PATH)
		.sort((a, b) => byCodepoint(a.path, b.path));
	const deletes = [...pkg.deletes].sort(byCodepoint);
	const seen = new Set<string>();
	for (const path of [...files.map((f) => f.path), ...deletes]) {
		if (seen.has(path)) throw new Error(`The package lists ${path} twice`);
		seen.add(path);
	}

	const hash = createHash("sha256");
	hash.update(`avel-package-hash\0${PACKAGE_HASH_VERSION}\0`, "utf8");
	for (const f of files) {
		if (gitBlobSha(f.bytes) !== f.blobSha) {
			throw new Error(`${f.path} carries a blob sha its bytes do not have`);
		}
		hash.update(`file\0${f.mode}\0${f.blobSha}\0${f.path}\0`, "utf8");
	}
	for (const path of deletes) hash.update(`delete\0${path}\0`, "utf8");
	return hash.digest("hex");
}

/**
 * What a zip holds: the package's files, plus .avel/deletes.json, the
 * package's deletes as a JSON array in codepoint order with a trailing
 * newline. The list is there even when empty, so a zip always says what it
 * removes. It is derived from the deletes the hash covers, so the hash
 * leaves it out.
 */
export function zipEntries(pkg: RenderedPackage): ZipEntry[] {
	const deletes = [...pkg.deletes].sort(byCodepoint);
	const list: ZipEntry = {
		path: DELETES_PATH,
		mode: "100644",
		bytes: new TextEncoder().encode(`${JSON.stringify(deletes, null, 2)}\n`),
	};
	return [
		...pkg.files.map((f) => ({ path: f.path, mode: f.mode, bytes: f.bytes })),
		list,
	].sort((a, b) => byCodepoint(a.path, b.path));
}
