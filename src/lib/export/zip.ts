import { constants, crc32, deflateRawSync } from "node:zlib";
import { byCodepoint } from "./order";
import type { PackageMode } from "./read";
import { refuse } from "./refusal";

export type ZipEntry = { path: string; mode: PackageMode; bytes: Uint8Array };

/**
 * Every deflate setting, pinned. The output is then fixed for a given zlib
 * build; a zlib that compresses the same bytes differently moves the
 * pinned digest in tests/unit/export-zip.test.ts (EXPORT-ENGINE.md §7).
 */
export const DEFLATE_OPTIONS = {
	level: 9,
	memLevel: 8,
	windowBits: 15,
	strategy: constants.Z_DEFAULT_STRATEGY,
} as const;

/** 1980-01-01 00:00, the earliest DOS date: (0 << 9) | (1 << 5) | 1. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
/** Bit 11: the name is UTF-8. No data descriptor, no encryption. */
const FLAGS = 0x0800;
const DEFLATE = 8;
/** 2.0, the version that introduced deflate. */
const VERSION_NEEDED = 20;
/** Made by Unix (3) at 2.0, so the external attributes carry the mode. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

/**
 * Whether a path is safe to hand to an extractor: relative, with forward
 * slashes, and no segment that is empty, "." or "..". A drive letter, a
 * backslash or a NUL is refused too.
 */
function unsafeReason(path: string): string | null {
	if (path === "") return "empty";
	if (path.startsWith("/")) return "absolute";
	if (/^[A-Za-z]:/.test(path)) return "drive letter";
	if (path.includes("\\")) return "backslash";
	if (path.includes("\0")) return "NUL";
	for (const segment of path.split("/")) {
		if (segment === "") return "empty segment";
		if (segment === "." || segment === "..") return `${segment} segment`;
	}
	return null;
}

/**
 * A zip of the entries, the same bytes for the same entries on every
 * machine. Hand-rolled on node:zlib (EXPORT-ENGINE.md §7): entries in
 * codepoint order of path, each deflated with DEFLATE_OPTIONS, every
 * timestamp 1980-01-01 00:00, the UTF-8 flag set, no extra fields, no
 * comments, and the Unix mode in each entry's external attributes. Files
 * only: extractors make the directories.
 *
 * Refused (ExportRefused) for a path that could write outside the
 * extraction directory, for two entries with one path, and for anything
 * that would need zip64.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
	const sorted = [...entries].sort((a, b) => byCodepoint(a.path, b.path));
	for (let i = 0; i < sorted.length; i++) {
		const e = sorted[i] as ZipEntry;
		const why = unsafeReason(e.path);
		if (why) {
			throw refuse(`A zip entry path is unsafe (${why})`, {
				reason: "unsafe_path",
				path: e.path,
			});
		}
		if (i > 0 && (sorted[i - 1] as ZipEntry).path === e.path) {
			throw refuse("Two zip entries have one path", {
				reason: "duplicate_path",
				path: e.path,
			});
		}
	}
	if (sorted.length > MAX16) {
		throw refuse("Too many entries for a zip without zip64", {
			reason: "zip_too_large",
		});
	}

	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of sorted) {
		const name = Buffer.from(e.path, "utf8");
		const data = deflateRawSync(e.bytes, DEFLATE_OPTIONS);
		const crc = crc32(e.bytes);
		if (
			e.bytes.byteLength >= MAX32 ||
			data.byteLength >= MAX32 ||
			offset >= MAX32 ||
			name.byteLength > MAX16
		) {
			throw refuse("An entry too large for a zip without zip64", {
				reason: "zip_too_large",
				path: e.path,
			});
		}

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(VERSION_NEEDED, 4);
		local.writeUInt16LE(FLAGS, 6);
		local.writeUInt16LE(DEFLATE, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.byteLength, 18);
		local.writeUInt32LE(e.bytes.byteLength, 22);
		local.writeUInt16LE(name.byteLength, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(VERSION_MADE_BY, 4);
		central.writeUInt16LE(VERSION_NEEDED, 6);
		central.writeUInt16LE(FLAGS, 8);
		central.writeUInt16LE(DEFLATE, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.byteLength, 20);
		central.writeUInt32LE(e.bytes.byteLength, 24);
		central.writeUInt16LE(name.byteLength, 28);
		central.writeUInt16LE(0, 30); // extra length
		central.writeUInt16LE(0, 32); // comment length
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attributes
		central.writeUInt32LE((Number.parseInt(e.mode, 8) << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.byteLength + name.byteLength + data.byteLength;
	}

	const cdSize = centrals.reduce((n, b) => n + b.byteLength, 0);
	if (offset >= MAX32 || cdSize >= MAX32) {
		throw refuse("Too many bytes for a zip without zip64", {
			reason: "zip_too_large",
		});
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4); // this disk
	end.writeUInt16LE(0, 6); // the central directory's disk
	end.writeUInt16LE(sorted.length, 8);
	end.writeUInt16LE(sorted.length, 10);
	end.writeUInt32LE(cdSize, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20); // comment length
	return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}
