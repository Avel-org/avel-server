import { createHash } from "node:crypto";
import { gitBlobSha } from "./blob";
import { byCodepoint } from "./order";
import type { PackageFile, PackageRead } from "./read";
import { refuse } from "./refusal";

/** Where the gate receipt sits in the package. */
export const RECEIPT_PATH = ".avel/receipt.json";

/**
 * The package (module 10, decided 2026-10-21): the files the gate's
 * integration commit changed from the mission's base, with their modes,
 * plus the gate receipt at .avel/receipt.json, and the paths the commit
 * deleted. Files and deletes are each sorted by codepoint.
 */
export type RenderedPackage = { files: PackageFile[]; deletes: string[] };

/**
 * The package from what readPackage read and the receipt's exact string.
 * Pure. The receipt is added as a 100644 file of the string's UTF-8 bytes.
 * Refused (ExportRefused) when the integration commit itself wrote or
 * deleted .avel/receipt.json, because the package's one would replace it.
 */
export function renderPackage(input: {
	read: PackageRead;
	receipt: string;
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
	const bytes = new TextEncoder().encode(input.receipt);
	const receipt: PackageFile = {
		path: RECEIPT_PATH,
		mode: "100644",
		bytes,
		blobSha: gitBlobSha(bytes),
	};
	return {
		files: [...read.files, receipt].sort((a, b) => byCodepoint(a.path, b.path)),
		deletes: [...read.deletes].sort(byCodepoint),
	};
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
 * The receipt is left out because the receipt names this hash. Each file's
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
