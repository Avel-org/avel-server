import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ExportRefused, readPackage } from "../../src/lib/export";
import {
	commitEntries,
	type Entry,
	plumbRepo,
	textFiles,
	writeBlob,
} from "./export-fixtures";
import { gitIn, removeDir, tempDir } from "./git-fixtures";

// readPackage against repositories built by plumbing, so every mode and
// every byte is exactly what the test says.

vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("export-read");
afterAll(() => removeDir(base));

let n = 0;
const repo = () => plumbRepo(path.join(base, `repo-${++n}`));

const BINARY = Uint8Array.from({ length: 256 }, (_, i) => 255 - i);
const CRLF = "line one\r\nline two\r\n";

async function refused(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		expect(err).toBeInstanceOf(ExportRefused);
		return (err as ExportRefused).details;
	}
	throw new Error("expected a refusal");
}

describe("readPackage", () => {
	it("reads every written path's mode and exact bytes, and every delete, in codepoint order", async () => {
		const dir = repo();
		const baseEntries: Entry[] = [
			...textFiles(dir, {
				"a.txt": "a\n",
				"del.txt": "gone\n",
				"keep.txt": "kept\n",
				"run.sh": "echo 1\n",
			}),
			{ path: "bin.dat", mode: "100644", sha: writeBlob(dir, "old\n") },
		];
		const baseSha = commitEntries(dir, baseEntries);
		const head = commitEntries(
			dir,
			[
				...textFiles(dir, {
					"a.txt": CRLF,
					"keep.txt": "kept\n",
					"new/ü.txt": "ü\n",
					"z/�.txt": "replacement\n",
					"z/😀.txt": "astral\n",
				}),
				{ path: "bin.dat", mode: "100644", sha: writeBlob(dir, BINARY) },
				{ path: "run.sh", mode: "100755", sha: writeBlob(dir, "echo 2\n") },
				{ path: "tool", mode: "100755", sha: writeBlob(dir, "#!/bin/sh\n") },
			],
			baseSha,
		);

		const read = await readPackage(dir, baseSha, head);
		expect(read.deletes).toEqual(["del.txt"]);
		expect(read.files.map((f) => [f.path, f.mode])).toEqual([
			["a.txt", "100644"],
			["bin.dat", "100644"],
			["new/ü.txt", "100644"],
			["run.sh", "100755"],
			["tool", "100755"],
			// Codepoint order: U+FFFD before U+1F600, which UTF-16 order reverses.
			["z/�.txt", "100644"],
			["z/😀.txt", "100644"],
		]);
		for (const f of read.files) {
			expect(f.blobSha).toBe(gitIn(dir, "rev-parse", `${head}:${f.path}`));
		}
		const bytesOf = (p: string) =>
			Buffer.from(read.files.find((f) => f.path === p)?.bytes ?? []);
		// CR kept, no conversion; every byte value survives.
		expect(bytesOf("a.txt").equals(Buffer.from(CRLF, "utf8"))).toBe(true);
		expect(bytesOf("bin.dat").equals(Buffer.from(BINARY))).toBe(true);
		expect(bytesOf("new/ü.txt").toString("utf8")).toBe("ü\n");
	});

	it("reads a rename as a delete and a write, and no change as nothing", async () => {
		const dir = repo();
		const baseSha = commitEntries(
			dir,
			textFiles(dir, { "old/name.ts": "export const x = 1;\n" }),
		);
		const head = commitEntries(
			dir,
			textFiles(dir, { "new/name.ts": "export const x = 1;\n" }),
			baseSha,
		);
		const read = await readPackage(dir, baseSha, head);
		expect(read.deletes).toEqual(["old/name.ts"]);
		expect(read.files.map((f) => f.path)).toEqual(["new/name.ts"]);

		const same = commitEntries(
			dir,
			textFiles(dir, { "old/name.ts": "export const x = 1;\n" }),
			baseSha,
			"1700000100 +0000",
		);
		expect(same).not.toBe(baseSha);
		expect(await readPackage(dir, baseSha, same)).toEqual({
			files: [],
			deletes: [],
		});
	});

	it("keeps a mode change that comes with new bytes", async () => {
		const dir = repo();
		const baseSha = commitEntries(dir, textFiles(dir, { "x.sh": "1\n" }));
		const head = commitEntries(
			dir,
			[{ path: "x.sh", mode: "100755", sha: writeBlob(dir, "2\n") }],
			baseSha,
		);
		const read = await readPackage(dir, baseSha, head);
		expect(read.files.map((f) => [f.path, f.mode])).toEqual([
			["x.sh", "100755"],
		]);
	});

	it("refuses a symlink added, a symlink turned into a file, and a symlink deleted, naming the path", async () => {
		const dir = repo();
		const target = writeBlob(dir, "a.txt");
		const plain = textFiles(dir, { "a.txt": "a\n" });
		const baseSha = commitEntries(dir, plain);
		const withLink = commitEntries(
			dir,
			[...plain, { path: "link", mode: "120000", sha: target }],
			baseSha,
		);
		expect(await refused(readPackage(dir, baseSha, withLink))).toEqual({
			reason: "symlink",
			path: "link",
		});
		// The other way: the link is on the base side only.
		expect(await refused(readPackage(dir, withLink, baseSha))).toEqual({
			reason: "symlink",
			path: "link",
		});
		const linkToFile = commitEntries(
			dir,
			[...plain, ...textFiles(dir, { link: "now a file\n" })],
			withLink,
		);
		expect(await refused(readPackage(dir, withLink, linkToFile))).toEqual({
			reason: "symlink",
			path: "link",
		});
	});

	it("refuses a submodule, naming the path", async () => {
		const dir = repo();
		const plain = textFiles(dir, { "a.txt": "a\n" });
		const baseSha = commitEntries(dir, plain);
		const head = commitEntries(
			dir,
			[...plain, { path: "vendor/lib", mode: "160000", sha: baseSha }],
			baseSha,
		);
		expect(await refused(readPackage(dir, baseSha, head))).toEqual({
			reason: "submodule",
			path: "vendor/lib",
		});
	});

	it("refuses a change of mode alone, naming the path", async () => {
		const dir = repo();
		const sha = writeBlob(dir, "echo\n");
		const baseSha = commitEntries(dir, [
			{ path: "run.sh", mode: "100644", sha },
		]);
		const head = commitEntries(
			dir,
			[{ path: "run.sh", mode: "100755", sha }],
			baseSha,
		);
		expect(await refused(readPackage(dir, baseSha, head))).toEqual({
			reason: "mode_only",
			path: "run.sh",
			from: "100644",
			to: "100755",
		});
	});

	it("refuses a path that is not UTF-8 instead of decoding it into another path", async () => {
		const dir = repo();
		const baseSha = commitEntries(dir, textFiles(dir, { "a.txt": "a\n" }));
		const head = commitEntries(
			dir,
			[
				...textFiles(dir, { "a.txt": "a\n" }),
				{
					path: Uint8Array.from([0x62, 0xff, 0x2e, 0x74]),
					mode: "100644",
					sha: writeBlob(dir, "x"),
				},
			],
			baseSha,
		);
		expect(await refused(readPackage(dir, baseSha, head))).toEqual({
			reason: "path_not_utf8",
			path: "bÿ.t",
		});
	});

	it("refuses a sha that is not a full commit sha", async () => {
		const dir = repo();
		const baseSha = commitEntries(dir, textFiles(dir, { "a.txt": "a\n" }));
		await expect(readPackage(dir, "HEAD", baseSha)).rejects.toThrow(/base/);
		await expect(readPackage(dir, baseSha, "main")).rejects.toThrow(/commit/);
	});
});
