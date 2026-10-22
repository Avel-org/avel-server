import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DELETES_PATH,
	ExportRefused,
	gitBlobSha,
	PACKAGE_HASH_VERSION,
	type PackageFile,
	type PackageMode,
	type PackageRead,
	packageSha256,
	RECEIPT_PATH,
	renderPackage,
	zipEntries,
} from "../../src/lib/export";

const file = (
	path: string,
	text: string | Uint8Array,
	mode: PackageMode = "100644",
): PackageFile => {
	const bytes =
		typeof text === "string" ? new TextEncoder().encode(text) : text;
	return { path, mode, bytes, blobSha: gitBlobSha(bytes) };
};

const READ: PackageRead = {
	files: [
		file("README.md", "# Salon\r\n"),
		file("bin/run", "#!/bin/sh\n", "100755"),
		file("src/ü.ts", "export const ü = 1;\n"),
		file("src/😀.ts", Uint8Array.from([0, 1, 2, 0xff])),
	],
	deletes: ["old/a.ts", "old/b.ts"],
};
const RECEIPT = '{"commitSha":"abc","verdict":"pass"}';

/**
 * The frozen digest of READ under PACKAGE_HASH_VERSION 1. If this moves, the
 * definition moved: bump PACKAGE_HASH_VERSION, never this value alone.
 */
const PINNED =
	"d4005b1cfb5e08efbbe581dd81523fba63231809361a1a33a8a9ddefb53dbc5c";

function refusal(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ExportRefused);
		return (err as ExportRefused).details;
	}
	throw new Error("expected a refusal");
}

describe("renderPackage", () => {
	it("adds the receipt's exact bytes at .avel/receipt.json, 100644, in codepoint order", () => {
		const pkg = renderPackage({ read: READ, receipt: RECEIPT });
		expect(pkg.files.map((f) => f.path)).toEqual([
			RECEIPT_PATH,
			"README.md",
			"bin/run",
			"src/ü.ts",
			"src/😀.ts",
		]);
		const receipt = pkg.files[0] as PackageFile;
		expect(receipt.mode).toBe("100644");
		expect(Buffer.from(receipt.bytes).toString("utf8")).toBe(RECEIPT);
		expect(receipt.blobSha).toBe(gitBlobSha(receipt.bytes));
		expect(pkg.deletes).toEqual(["old/a.ts", "old/b.ts"]);
	});

	it("refuses when the integration commit wrote or deleted the receipt's path", () => {
		expect(
			refusal(() =>
				renderPackage({
					read: { ...READ, files: [...READ.files, file(RECEIPT_PATH, "{}")] },
					receipt: RECEIPT,
				}),
			),
		).toEqual({ reason: "receipt_path_written", path: RECEIPT_PATH });
		expect(
			refusal(() =>
				renderPackage({
					read: { ...READ, deletes: [RECEIPT_PATH] },
					receipt: RECEIPT,
				}),
			),
		).toEqual({ reason: "receipt_path_written", path: RECEIPT_PATH });
	});
});

describe("the deletes list", () => {
	const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

	it("is in every zip at .avel/deletes.json, a sorted JSON array, empty when nothing is deleted", () => {
		// Unsorted on purpose: zipEntries sorts what it is given.
		const pkg = {
			...renderPackage({ read: READ, receipt: RECEIPT }),
			deletes: ["old/b.ts", "old/a.ts"],
		};
		const entries = zipEntries(pkg);
		expect(entries.map((e) => e.path)).toEqual([
			DELETES_PATH,
			RECEIPT_PATH,
			"README.md",
			"bin/run",
			"src/ü.ts",
			"src/😀.ts",
		]);
		const list = entries[0];
		expect(list?.mode).toBe("100644");
		expect(text(list?.bytes as Uint8Array)).toBe(
			'[\n  "old/a.ts",\n  "old/b.ts"\n]\n',
		);
		const none = zipEntries(
			renderPackage({ read: { ...READ, deletes: [] }, receipt: RECEIPT }),
		);
		expect(
			text(none.find((e) => e.path === DELETES_PATH)?.bytes as Uint8Array),
		).toBe("[]\n");
	});

	it("is not a package file, so the hash does not see it", () => {
		const pkg = renderPackage({ read: READ, receipt: RECEIPT });
		expect(pkg.files.map((f) => f.path)).not.toContain(DELETES_PATH);
		expect(packageSha256(pkg)).toBe(PINNED);
	});

	it("refuses when the integration commit wrote or deleted its path", () => {
		for (const read of [
			{ ...READ, files: [...READ.files, file(DELETES_PATH, "[]\n")] },
			{ ...READ, deletes: [DELETES_PATH] },
		]) {
			expect(refusal(() => renderPackage({ read, receipt: RECEIPT }))).toEqual({
				reason: "deletes_path_written",
				path: DELETES_PATH,
			});
		}
	});
});

describe("packageSha256", () => {
	const pkg = () => renderPackage({ read: READ, receipt: RECEIPT });

	it("is version 1", () => {
		expect(PACKAGE_HASH_VERSION).toBe(1);
	});

	it("equals the frozen digest", () => {
		expect(packageSha256(pkg())).toBe(PINNED);
	});

	it("is the sha256 of the encoding its doc comment writes down", () => {
		const parts = [
			"avel-package-hash\0",
			"1\0",
			...[...READ.files]
				.sort((a, b) =>
					Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
				)
				.map((f) => `file\0${f.mode}\0${f.blobSha}\0${f.path}\0`),
			"delete\0old/a.ts\0",
			"delete\0old/b.ts\0",
		];
		const expected = createHash("sha256")
			.update(Buffer.from(parts.join(""), "utf8"))
			.digest("hex");
		expect(packageSha256(pkg())).toBe(expected);
	});

	it("leaves the receipt out", () => {
		const other = renderPackage({ read: READ, receipt: '{"other":true}' });
		expect(packageSha256(other)).toBe(packageSha256(pkg()));
	});

	it("does not depend on the order the files and deletes arrive in", () => {
		const p = pkg();
		expect(
			packageSha256({
				files: [...p.files].reverse(),
				deletes: [...p.deletes].reverse(),
			}),
		).toBe(packageSha256(p));
	});

	it("moves with a file's bytes, its mode, its path, and with a delete", () => {
		const h = packageSha256(pkg());
		const swap = (files: PackageFile[], deletes = READ.deletes) =>
			packageSha256(
				renderPackage({ read: { files, deletes }, receipt: RECEIPT }),
			);
		const [first, ...rest] = READ.files as [PackageFile, ...PackageFile[]];
		expect(swap([file(first.path, "# Salon\n"), ...rest])).not.toBe(h);
		expect(swap([file(first.path, "# Salon\r\n", "100755"), ...rest])).not.toBe(
			h,
		);
		expect(swap([{ ...first, path: "README.txt" }, ...rest])).not.toBe(h);
		expect(swap(READ.files, ["old/a.ts"])).not.toBe(h);
		expect(swap(READ.files, [...READ.deletes, "old/c.ts"])).not.toBe(h);
	});

	it("refuses a file whose blob sha is not its bytes', and a path listed twice", () => {
		const p = pkg();
		const [first, ...rest] = p.files as [PackageFile, ...PackageFile[]];
		const lying = { ...rest[0], blobSha: first.blobSha } as PackageFile;
		expect(() =>
			packageSha256({ files: [first, lying, ...rest.slice(1)], deletes: [] }),
		).toThrow(/blob sha/);
		expect(() =>
			packageSha256({ files: p.files, deletes: ["README.md"] }),
		).toThrow(/twice/);
	});
});
