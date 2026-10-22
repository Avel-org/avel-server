import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/lib/canonical";
import {
	type BlastRadiusPolicy,
	byCodepoint,
	computeBlastRadius,
	type DeliveryPackage,
	normalizePath,
	type PackageFile,
	type RemoteEntry,
	type RemoteTree,
	type ViolationCode,
} from "../../src/lib/export/delivery";

const SHA = (n: number) => n.toString(16).padStart(40, "0");
const CONTEXT = {
	computedAt: "2026-10-21T12:00:00.000Z",
	baseRef: "main",
	target: { owner: "meridian", repo: "app", branch: "avel/mission-1" },
};
const POLICY: BlastRadiusPolicy = {
	writablePaths: ["src/**", "tests/**"],
	protectedPaths: [],
};

function file(path: string, n = 1, mode = "100644"): PackageFile {
	return { path, mode, bytes: n * 10, blobSha: SHA(n) };
}

function remote(
	entries: Record<string, number | RemoteEntry>,
	commitSha: string | null = "a".repeat(40),
): RemoteTree {
	return {
		commitSha,
		entries: new Map(
			Object.entries(entries).map(([p, e]) => [
				p,
				typeof e === "number" ? { sha: SHA(e), mode: "100644" } : e,
			]),
		),
	};
}

function radius(
	pkg: Partial<DeliveryPackage>,
	tree: RemoteTree = remote({}),
	policy: BlastRadiusPolicy = POLICY,
) {
	return computeBlastRadius(
		{ files: pkg.files ?? [], deletes: pkg.deletes ?? [] },
		tree,
		policy,
		CONTEXT,
	);
}

function codes(r: ReturnType<typeof radius>, path: string): ViolationCode[] {
	return r.violations.filter((v) => v.path === path).map((v) => v.code);
}

describe("computeBlastRadius: groups", () => {
	it("puts a new path in create, a changed one in overwrite and an identical one in unchanged", () => {
		const r = radius(
			{
				files: [
					file("src/new.ts", 1),
					file("src/changed.ts", 2),
					file("src/same.ts", 3),
				],
			},
			remote({ "src/changed.ts": 9, "src/same.ts": 3, "README.md": 4 }),
		);
		expect(r.create.map((f) => f.path)).toEqual(["src/new.ts"]);
		expect(r.overwrite).toEqual([
			{
				path: "src/changed.ts",
				mode: "100644",
				bytes: 20,
				blobSha: SHA(2),
				remoteBlobSha: SHA(9),
				remoteMode: "100644",
			},
		]);
		expect(r.unchanged.map((f) => f.path)).toEqual(["src/same.ts"]);
		expect(r.violations).toEqual([]);
		expect(r.totals).toEqual({
			create: 1,
			overwrite: 1,
			unchanged: 1,
			delete: 0,
			violations: 0,
		});
	});

	it("counts a mode change with identical bytes as an overwrite", () => {
		const r = radius(
			{ files: [file("src/run.sh", 1, "100755")] },
			remote({ "src/run.sh": 1 }),
		);
		expect(r.overwrite.map((f) => f.path)).toEqual(["src/run.sh"]);
		expect(r.unchanged).toEqual([]);
	});

	it("puts a delete of a remote file in delete, and it is not preserved", () => {
		const r = radius(
			{ deletes: ["src/old.ts"] },
			remote({ "src/old.ts": 5, "src/keep.ts": 6 }),
		);
		expect(r.delete).toEqual([
			{ path: "src/old.ts", remoteBlobSha: SHA(5), remoteMode: "100644" },
		]);
		expect(r.totals.delete).toBe(1);
		expect(r.preserveSummary.fileCount).toBe(1);
	});

	it("treats every file as a create in an empty repository", () => {
		const r = radius(
			{ files: [file("src/a.ts"), file(".avel/brief.md")] },
			remote({}, null),
		);
		expect(r.baseCommitSha).toBeNull();
		expect(r.create.map((f) => f.path)).toEqual([".avel/brief.md", "src/a.ts"]);
		expect(r.preserveSummary).toEqual({ fileCount: 0, topLevelDirs: [] });
	});

	it("refuses an empty repository that has entries", () => {
		expect(() => radius({}, remote({ a: 1 }, null))).toThrow();
	});

	it("summarizes PRESERVE as a count and top-level names, never a list", () => {
		const r = radius(
			{ files: [file("src/a.ts", 1)] },
			remote({
				"src/a.ts": 1,
				"src/b.ts": 2,
				"docs/x.md": 3,
				"package.json": 4,
				"Zeta/y.md": 5,
				"alpha/z.md": 6,
				"docs/sub": { sha: SHA(7), mode: "040000" },
			}),
		);
		expect(r.preserveSummary).toEqual({
			fileCount: 5,
			// Codepoint order: uppercase before lowercase, never locale order.
			topLevelDirs: ["Zeta/", "alpha/", "docs/", "package.json", "src/"],
		});
		expect(JSON.stringify(r)).not.toContain("src/b.ts");
	});

	it("records the passed-in context and the remote commit", () => {
		const r = radius({}, remote({}, "b".repeat(40)));
		expect(r.computedAt).toBe(CONTEXT.computedAt);
		expect(r.baseRef).toBe("main");
		expect(r.baseCommitSha).toBe("b".repeat(40));
		expect(r.target).toEqual(CONTEXT.target);
	});
});

describe("computeBlastRadius: violations", () => {
	it("flags a path outside the roster's writable paths and .avel/", () => {
		const r = radius({
			files: [file("lib/x.ts"), file(".avel/agents/a.md"), file("src/y.ts")],
		});
		expect(codes(r, "lib/x.ts")).toEqual(["PATH_OUTSIDE_ALLOWED"]);
		expect(codes(r, ".avel/agents/a.md")).toEqual([]);
		expect(codes(r, "src/y.ts")).toEqual([]);
		// Still classified, so the operator sees what it would have done.
		expect(r.create.map((f) => f.path)).toContain("lib/x.ts");
	});

	it("allows only .avel/ when the roster declares no writable paths", () => {
		const r = radius(
			{ files: [file("src/x.ts"), file(".avel/x.md")] },
			remote({}),
			{ writablePaths: [], protectedPaths: [] },
		);
		expect(codes(r, "src/x.ts")).toEqual(["PATH_OUTSIDE_ALLOWED"]);
		expect(codes(r, ".avel/x.md")).toEqual([]);
	});

	it("flags traversal and absolute paths and does not classify them", () => {
		const r = radius({
			files: [file("src/../../etc/passwd"), file("C:/x/src/a.ts")],
		});
		expect(codes(r, "src/../../etc/passwd")).toEqual(["PATH_TRAVERSAL"]);
		expect(codes(r, "C:/x/src/a.ts")).toEqual(["PATH_TRAVERSAL"]);
		expect(r.create).toEqual([]);
	});

	it("flags a leading slash as absolute and as not normalized", () => {
		const r = radius({ files: [file("/src/a.ts")] });
		expect(codes(r, "/src/a.ts").sort(byCodepoint)).toEqual([
			"PATH_NOT_NORMALIZED",
			"PATH_TRAVERSAL",
		]);
	});

	it("flags a path that changes under normalization", () => {
		const nfd = "src/cafe\u0301.ts";
		const r = radius({
			files: [
				file("src\\a.ts"),
				file(nfd),
				file("src//b.ts"),
				file("src/./c.ts"),
			],
		});
		expect(codes(r, "src\\a.ts")).toEqual(["PATH_NOT_NORMALIZED"]);
		expect(codes(r, nfd)).toEqual(["PATH_NOT_NORMALIZED"]);
		expect(codes(r, "src//b.ts")).toEqual(["PATH_NOT_NORMALIZED"]);
		expect(codes(r, "src/./c.ts")).toEqual(["PATH_NOT_NORMALIZED"]);
		expect(r.create).toEqual([]);
	});

	it("flags an empty path", () => {
		expect(codes(radius({ files: [file("")] }), "")).toEqual([
			"PATH_TRAVERSAL",
		]);
	});

	it("flags a write onto a remote symlink or submodule as a collision, not an overwrite", () => {
		const r = radius(
			{ files: [file("src/link"), file("src/vendor")] },
			remote({
				"src/link": { sha: SHA(1), mode: "120000" },
				"src/vendor": { sha: SHA(2), mode: "160000" },
			}),
		);
		expect(codes(r, "src/link")).toEqual(["SPECIAL_FILE_COLLISION"]);
		expect(codes(r, "src/vendor")).toEqual(["SPECIAL_FILE_COLLISION"]);
		expect(r.overwrite).toEqual([]);
	});

	it("flags a write under a remote symlink and does not classify it", () => {
		const r = radius(
			{ files: [file("src/lib/a.ts")] },
			remote({ "src/lib": { sha: SHA(1), mode: "120000" } }),
		);
		expect(codes(r, "src/lib/a.ts")).toEqual(["SPECIAL_FILE_COLLISION"]);
		expect(r.create).toEqual([]);
	});

	it("flags a file written where the repository has a directory, or under a file", () => {
		const r = radius(
			{ files: [file("src/dir"), file("src/f.ts/inner.ts")] },
			remote({ "src/dir/x.ts": 1, "src/f.ts": 2 }),
		);
		expect(codes(r, "src/dir")).toEqual(["PATH_TYPE_COLLISION"]);
		expect(codes(r, "src/f.ts/inner.ts")).toEqual(["PATH_TYPE_COLLISION"]);
		expect(r.create).toEqual([]);
		expect(r.overwrite).toEqual([]);
	});

	it("flags a package file that is also a directory in the package", () => {
		const r = radius({ files: [file("src/a"), file("src/a/b.ts")] });
		expect(codes(r, "src/a")).toEqual(["PATH_TYPE_COLLISION"]);
		expect(codes(r, "src/a/b.ts")).toEqual([]);
	});

	it("flags two package paths that differ only in case", () => {
		const r = radius({
			files: [file("src/Agents/x.md"), file("src/agents/x.md")],
		});
		expect(codes(r, "src/Agents/x.md")).toContain("CASE_COLLISION");
		expect(codes(r, "src/agents/x.md")).toContain("CASE_COLLISION");
	});

	it("flags a package path that differs from a remote path only in case", () => {
		const r = radius(
			{ files: [file("src/Readme.md")] },
			remote({ "src/README.md": 1 }),
		);
		expect(codes(r, "src/Readme.md")).toEqual(["CASE_COLLISION"]);
	});

	it("flags a package directory that differs from a remote one only in case", () => {
		const r = radius(
			{ files: [file("src/Agents/y.md")] },
			remote({ "src/agents/x.md": 1 }),
		);
		expect(codes(r, "src/Agents/y.md")).toEqual(["CASE_COLLISION"]);
	});

	it("counts an exact remote match as an overwrite, not a collision", () => {
		const r = radius(
			{ files: [file("src/README.md", 2)] },
			remote({ "src/README.md": 1 }),
		);
		expect(r.violations).toEqual([]);
		expect(r.overwrite.map((f) => f.path)).toEqual(["src/README.md"]);
	});

	it("protects .git at any depth and in any case, and .github/workflows", () => {
		const r = radius(
			{
				files: [
					file(".git/config"),
					file("src/.GIT/hooks/pre-commit"),
					file(".github/workflows/ci.yml"),
				],
			},
			remote({}),
			{ writablePaths: ["**"], protectedPaths: [] },
		);
		expect(codes(r, ".git/config")).toEqual(["PROTECTED_PATH"]);
		expect(codes(r, "src/.GIT/hooks/pre-commit")).toEqual(["PROTECTED_PATH"]);
		expect(codes(r, ".github/workflows/ci.yml")).toEqual(["PROTECTED_PATH"]);
	});

	it("protects a passed-in denylist", () => {
		const r = radius(
			{ files: [file("src/secrets/key.pem"), file("src/ok.ts")] },
			remote({}),
			{
				writablePaths: ["src/**"],
				protectedPaths: ["src/secrets/**"],
			},
		);
		expect(codes(r, "src/secrets/key.pem")).toEqual(["PROTECTED_PATH"]);
		expect(codes(r, "src/ok.ts")).toEqual([]);
	});

	it("blocks on a denylist glob the matcher cannot read", () => {
		const r = radius({ files: [file("src/ok.ts")] }, remote({}), {
			writablePaths: ["src/**"],
			protectedPaths: ["src/{a,b}/**"],
		});
		expect(r.violations.map((v) => v.code)).toEqual([
			"POLICY_GLOB_UNSUPPORTED",
		]);
	});

	it("flags a delete of a path the repository does not have", () => {
		const r = radius(
			{ deletes: ["src/gone.ts"] },
			remote({ "src/here.ts": 1 }),
		);
		expect(codes(r, "src/gone.ts")).toEqual(["DELETE_NOT_FOUND"]);
		expect(r.delete).toEqual([]);
	});

	it("flags a delete in an empty repository", () => {
		const r = radius({ deletes: ["src/a.ts"] }, remote({}, null));
		expect(codes(r, "src/a.ts")).toEqual(["DELETE_NOT_FOUND"]);
	});

	it("flags a delete of a directory the tree lists as one", () => {
		const r = radius(
			{ deletes: ["src/dir"] },
			remote({ "src/dir": { sha: SHA(1), mode: "040000" } }),
		);
		expect(codes(r, "src/dir")).toEqual(["DELETE_NOT_FOUND"]);
		expect(r.delete).toEqual([]);
	});

	it("reports each violation once, however many times the package names the path", () => {
		const r = radius({
			files: [file("src/a", 1, "120000"), file("src/a", 2, "120000")],
		});
		expect(codes(r, "src/a")).toEqual(["DUPLICATE_PATH", "UNSUPPORTED_MODE"]);
	});

	it("flags a delete of a directory", () => {
		const r = radius({ deletes: ["src/dir"] }, remote({ "src/dir/a.ts": 1 }));
		expect(codes(r, "src/dir")).toEqual(["DELETE_NOT_FOUND"]);
	});

	it("flags a delete of a symlink as a special-file collision", () => {
		const r = radius(
			{ deletes: ["src/link"] },
			remote({ "src/link": { sha: SHA(1), mode: "120000" } }),
		);
		expect(codes(r, "src/link")).toEqual(["SPECIAL_FILE_COLLISION"]);
		expect(r.delete).toEqual([]);
	});

	it("applies the path rules to deletes", () => {
		const r = radius(
			{ deletes: ["lib/a.ts", ".github/workflows/ci.yml", "src/../x"] },
			remote({ "lib/a.ts": 1, ".github/workflows/ci.yml": 2 }),
			{ writablePaths: ["src/**", ".github/**"], protectedPaths: [] },
		);
		expect(codes(r, "lib/a.ts")).toEqual(["PATH_OUTSIDE_ALLOWED"]);
		expect(codes(r, ".github/workflows/ci.yml")).toEqual(["PROTECTED_PATH"]);
		expect(codes(r, "src/../x")).toEqual(["PATH_TRAVERSAL"]);
	});

	it("flags a path the package names twice, in files or across files and deletes", () => {
		const r = radius(
			{
				files: [file("src/a.ts", 1), file("src/a.ts", 2), file("src/b.ts")],
				deletes: ["src/b.ts"],
			},
			remote({ "src/b.ts": 3 }),
		);
		expect(codes(r, "src/a.ts")).toEqual(["DUPLICATE_PATH"]);
		expect(codes(r, "src/b.ts")).toEqual(["DUPLICATE_PATH"]);
		expect(r.create).toEqual([]);
		expect(r.overwrite).toEqual([]);
		expect(r.delete).toEqual([]);
	});

	it("flags a package file mode that is not a regular or executable file", () => {
		const r = radius({
			files: [file("src/link", 1, "120000"), file("src/sub", 2, "160000")],
		});
		expect(codes(r, "src/link")).toEqual(["UNSUPPORTED_MODE"]);
		expect(codes(r, "src/sub")).toEqual(["UNSUPPORTED_MODE"]);
		expect(r.create).toEqual([]);
	});

	it("totals the violations", () => {
		const r = radius({ files: [file("lib/a.ts"), file("lib/b.ts")] });
		expect(r.totals.violations).toBe(2);
	});
});

describe("computeBlastRadius: determinism", () => {
	const files = [
		file("src/b.ts", 2),
		file("src/a.ts", 1),
		file("src/\u{1F600}.ts", 3),
		file("src/\uFF21.ts", 4),
		file("lib/z.ts", 5),
	];
	const tree = remote({ "src/a.ts": 9, "docs/x.md": 1, "README.md": 2 });

	it("does not depend on input order", () => {
		const a = radius({ files, deletes: ["README.md", "docs/x.md"] }, tree);
		const b = radius(
			{ files: [...files].reverse(), deletes: ["docs/x.md", "README.md"] },
			remote(Object.fromEntries([...tree.entries].reverse())),
		);
		expect(canonicalJson(a)).toBe(canonicalJson(b));
	});

	it("orders paths by codepoint: U+FF21 before U+1F600", () => {
		const r = radius({ files }, tree);
		expect(r.create.map((f) => f.path)).toEqual([
			"lib/z.ts",
			"src/b.ts",
			"src/\uFF21.ts",
			"src/\u{1F600}.ts",
		]);
	});

	it("pins a digest of one fixture", () => {
		const r = radius({ files, deletes: ["README.md", "gone.md"] }, tree);
		const digest = createHash("sha256").update(canonicalJson(r)).digest("hex");
		expect(digest).toBe(
			"bf1c21d89560ea11fc2bd4cccaa43b13136bf0928d160257c43e6942ea9b80a1",
		);
	});
});

describe("normalizePath", () => {
	it("uses POSIX separators, drops a leading slash and composes to NFC", () => {
		expect(normalizePath("\\a\\b")).toBe("a/b");
		expect(normalizePath("//a")).toBe("a");
		expect(normalizePath("e\u0301")).toBe("\u00e9");
	});
});

describe("byCodepoint", () => {
	it("orders by codepoint, which differs from code-unit order above U+FFFF", () => {
		const astral = "\u{1F600}";
		const bmpHigh = "\uFF21";
		expect(byCodepoint(bmpHigh, astral)).toBe(-1);
		expect(bmpHigh < astral).toBe(false);
		expect(byCodepoint("a", "b")).toBe(-1);
		expect(byCodepoint("ab", "a")).toBe(1);
		expect(byCodepoint("a", "a")).toBe(0);
		expect(byCodepoint("I", "i")).toBe(-1);
	});
});
