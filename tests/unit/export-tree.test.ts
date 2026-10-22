import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitBlobSha } from "../../src/lib/export";
import { localTree } from "../../src/lib/export/tree";
import { gitIn, makeRepo, removeDir, tempDir } from "./git-fixtures";

const base = tempDir("export-tree");
afterAll(() => removeDir(base));

describe("localTree", () => {
	it("lists every blob and directory at the commit, with git's modes and shas", () => {
		const dir = path.join(base, "repo");
		const [sha] = makeRepo(dir, {
			"src/a.ts": "export const a = 1;\n",
			"README.md": "# r\n",
		}) as [string];
		return localTree(dir, sha).then((t) => {
			expect(t.commitSha).toBe(sha);
			expect([...t.entries.keys()].sort()).toEqual([
				"README.md",
				"src",
				"src/a.ts",
			]);
			expect(t.entries.get("src")?.mode).toBe("040000");
			expect(t.entries.get("src/a.ts")).toEqual({
				mode: "100644",
				sha: gitBlobSha(new TextEncoder().encode("export const a = 1;\n")),
			});
		});
	});

	it("keeps a symlink as a symlink", async () => {
		// Added through the index, since Windows may refuse to make one on disk.
		const dir = path.join(base, "links");
		makeRepo(dir, { "a.txt": "a\n" });
		const target = execFileSync("git", ["hash-object", "-w", "--stdin"], {
			cwd: dir,
			input: "a.txt",
		})
			.toString()
			.trim();
		gitIn(dir, "update-index", "--add", "--cacheinfo", `120000,${target},link`);
		gitIn(dir, "commit", "--quiet", "-m", "link");
		const sha = gitIn(dir, "rev-parse", "HEAD").trim();
		expect((await localTree(dir, sha)).entries.get("link")).toEqual({
			mode: "120000",
			sha: target,
		});
	});

	it("refuses a commit that is not a full sha", async () => {
		await expect(localTree(base, "HEAD")).rejects.toThrow(/not a full sha/);
	});
});
