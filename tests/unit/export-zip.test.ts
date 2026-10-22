import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { ExportRefused, writeZip, type ZipEntry } from "../../src/lib/export";
import { removeDir, tempDir } from "./git-fixtures";

// The zip writer. Its bytes are pinned by digest; the archive is read back
// three ways: by a central-directory reader written here from the format,
// by Python's zipfile (CRCs checked), and, where it is installed, by
// libarchive's bsdtar extracting to disk.

const base = tempDir("export-zip");
afterAll(() => removeDir(base));

const text = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

const ENTRIES: ZipEntry[] = [
	{ path: "src/😀.ts", mode: "100644", bytes: Uint8Array.from([0, 1, 0xff]) },
	{ path: "bin/run", mode: "100755", bytes: text("#!/bin/sh\necho hi\n") },
	{ path: ".avel/receipt.json", mode: "100644", bytes: text('{"a":1}') },
	{ path: "empty.txt", mode: "100644", bytes: new Uint8Array() },
	{ path: "src/ü.ts", mode: "100644", bytes: text("a\r\nb\r\n".repeat(50)) },
];
const ORDER = [
	".avel/receipt.json",
	"bin/run",
	"empty.txt",
	"src/ü.ts",
	"src/😀.ts",
];

/** The sha256 of writeZip(ENTRIES). It moves if any byte of the archive moves. */
const PINNED =
	"d1cf96b44bc6e1cae83c05913017a32e9358a72b84143031eb64fab2831e5984";

type Read = {
	path: string;
	bytes: Buffer;
	flags: number;
	time: number;
	date: number;
	madeBy: number;
	external: number;
};

/** Reads every entry through the central directory, checking each local header and CRC. */
function readZip(zip: Buffer): Read[] {
	const end = zip.length - 22;
	expect(zip.readUInt32LE(end)).toBe(0x06054b50);
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	expect(at + zip.readUInt32LE(end + 12)).toBe(end);
	const out: Read[] = [];
	for (let i = 0; i < count; i++) {
		expect(zip.readUInt32LE(at)).toBe(0x02014b50);
		const nameLen = zip.readUInt16LE(at + 28);
		const extra = zip.readUInt16LE(at + 30);
		const comment = zip.readUInt16LE(at + 32);
		const name = zip.subarray(at + 46, at + 46 + nameLen);
		const local = zip.readUInt32LE(at + 42);
		expect(zip.readUInt32LE(local)).toBe(0x04034b50);
		expect(zip.subarray(local + 30, local + 30 + nameLen).equals(name)).toBe(
			true,
		);
		const size = zip.readUInt32LE(at + 20);
		const start = local + 30 + nameLen + zip.readUInt16LE(local + 28);
		expect(zip.readUInt16LE(at + 10)).toBe(8);
		const bytes = inflateRawSync(zip.subarray(start, start + size));
		expect(bytes.length).toBe(zip.readUInt32LE(at + 24));
		expect(crc32(bytes)).toBe(zip.readUInt32LE(at + 16));
		// The local header says what the central one does, from flags to sizes.
		expect(zip.subarray(local + 6, local + 26)).toEqual(
			zip.subarray(at + 8, at + 28),
		);
		out.push({
			path: name.toString("utf8"),
			bytes,
			flags: zip.readUInt16LE(at + 8),
			time: zip.readUInt16LE(at + 12),
			date: zip.readUInt16LE(at + 14),
			madeBy: zip.readUInt16LE(at + 4),
			external: zip.readUInt32LE(at + 38),
		});
		at += 46 + nameLen + extra + comment;
	}
	return out;
}

let k = 0;
function saved(zip: Uint8Array): string {
	const file = path.join(base, `fixture-${++k}.zip`);
	writeFileSync(file, zip);
	return file;
}

function findPython(): string | null {
	for (const exe of ["python3", "python"]) {
		try {
			execFileSync(exe, ["-I", "-c", "import zipfile"], { stdio: "ignore" });
			return exe;
		} catch {}
	}
	return null;
}
const python = findPython();

const bsdtar =
	process.platform === "win32"
		? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
		: "bsdtar";
const hasBsdtar = (() => {
	try {
		execFileSync(bsdtar, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const PY_READ = [
	"import base64, json, sys, zipfile",
	"z = zipfile.ZipFile(sys.argv[1])",
	"assert z.testzip() is None",
	"print(json.dumps([[i.filename, list(i.date_time), i.external_attr >> 16,",
	"  i.flag_bits, base64.b64encode(z.read(i)).decode()] for i in z.infolist()]))",
].join("\n");

function refusal(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ExportRefused);
		return (err as ExportRefused).details;
	}
	throw new Error("expected a refusal");
}

describe("writeZip", () => {
	it("equals the frozen digest", () => {
		const digest = createHash("sha256").update(writeZip(ENTRIES)).digest("hex");
		expect(digest).toBe(PINNED);
	});

	it("gives the same bytes whatever order the entries arrive in", () => {
		expect(Buffer.from(writeZip([...ENTRIES].reverse()))).toEqual(
			Buffer.from(writeZip(ENTRIES)),
		);
	});

	it("holds every entry in codepoint order, with pinned time, date, flags and the Unix mode", () => {
		const read = readZip(Buffer.from(writeZip(ENTRIES)));
		expect(read.map((r) => r.path)).toEqual(ORDER);
		for (const r of read) {
			const entry = ENTRIES.find((e) => e.path === r.path) as ZipEntry;
			expect(r.bytes.equals(Buffer.from(entry.bytes))).toBe(true);
			expect(r.flags).toBe(0x0800);
			expect(r.time).toBe(0);
			expect(r.date).toBe(0x0021);
			expect(r.madeBy).toBe(0x0314);
			expect(r.external >>> 16).toBe(Number.parseInt(entry.mode, 8));
		}
	});

	it("writes an empty archive as the end record alone", () => {
		expect(Buffer.from(writeZip([])).toString("hex")).toBe(
			`504b0506${"00".repeat(18)}`,
		);
	});

	it.skipIf(!python)(
		"reads back through Python's zipfile, CRCs checked, at 1980-01-01 00:00",
		() => {
			const file = saved(writeZip(ENTRIES));
			const out = JSON.parse(
				execFileSync(python as string, ["-I", "-c", PY_READ, file], {
					encoding: "utf8",
				}),
			) as [string, number[], number, number, string][];
			expect(out.map((o) => o[0])).toEqual(ORDER);
			for (const [name, dateTime, mode, flags, b64] of out) {
				const entry = ENTRIES.find((e) => e.path === name) as ZipEntry;
				expect(dateTime).toEqual([1980, 1, 1, 0, 0, 0]);
				expect(mode).toBe(Number.parseInt(entry.mode, 8));
				expect(flags & 0x0800).toBe(0x0800);
				expect(
					Buffer.from(b64, "base64").equals(Buffer.from(entry.bytes)),
				).toBe(true);
			}
		},
	);

	it.skipIf(!hasBsdtar)("extracts to disk with bsdtar, byte for byte", () => {
		// Windows' bsdtar skips a name it cannot map to the ANSI code page
		// ("unreadable filename"), as it does U+1F600, so the astral name is
		// left out here; Python's zipfile above reads it.
		const bmp = ENTRIES.filter((e) => !/[\u{10000}-\u{10FFFF}]/u.test(e.path));
		expect(bmp.length).toBe(ENTRIES.length - 1);
		const file = saved(writeZip(bmp));
		const into = tempDir("export-unzip");
		try {
			execFileSync(bsdtar, ["-xf", file, "-C", into]);
			for (const e of bmp) {
				const at = path.join(into, ...e.path.split("/"));
				expect(existsSync(at)).toBe(true);
				expect(readFileSync(at).equals(Buffer.from(e.bytes))).toBe(true);
			}
		} finally {
			removeDir(into);
		}
	});

	it("refuses a path that could write outside the extraction directory", () => {
		const bad = [
			"../x",
			"a/../../x",
			"a/..",
			"/etc/passwd",
			"C:/x",
			"a\\b",
			"..\\x",
			"a//b",
			"a/",
			"",
			"./a",
			"a/./b",
			"a\0b",
		];
		for (const p of bad) {
			expect(
				refusal(() =>
					writeZip([{ path: p, mode: "100644", bytes: text("x") }]),
				),
			).toEqual({ reason: "unsafe_path", path: p });
		}
		// A dot in a name is not a dot segment.
		expect(() =>
			writeZip([{ path: "a/..b/.c", mode: "100644", bytes: text("x") }]),
		).not.toThrow();
	});

	it("refuses two entries with one path", () => {
		const e: ZipEntry = { path: "a", mode: "100644", bytes: text("x") };
		expect(refusal(() => writeZip([e, { ...e, bytes: text("y") }]))).toEqual({
			reason: "duplicate_path",
			path: "a",
		});
	});
});
