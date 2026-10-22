import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { gitIn } from "./git-fixtures";

// Repositories built by plumbing for the export tests: blobs from exact
// bytes, trees from exact (mode, sha, path) entries, commits at a fixed
// date by a fixed identity, unsigned. So symlinks, submodules, mode changes
// and paths that are not UTF-8 can be made on any platform, and every sha
// is the same on every machine. Not collected as a test file.

export const FIXED_DATE = "1700000000 +0000";

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
	...process.env,
	GIT_AUTHOR_NAME: "Export tests",
	GIT_AUTHOR_EMAIL: "export@example.com",
	GIT_AUTHOR_DATE: FIXED_DATE,
	GIT_COMMITTER_NAME: "Export tests",
	GIT_COMMITTER_EMAIL: "export@example.com",
	GIT_COMMITTER_DATE: FIXED_DATE,
	...extra,
});

function gitRaw(
	cwd: string,
	args: string[],
	input?: Uint8Array,
	extraEnv?: NodeJS.ProcessEnv,
): string {
	return execFileSync(
		"git",
		["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
		{ cwd, input, env: env(extraEnv), encoding: "utf8", windowsHide: true },
	).trim();
}

/** An empty repository at `dir` with signing off. */
export function plumbRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	gitIn(dir, "init", "--quiet", "--initial-branch=main");
	gitIn(dir, "config", "commit.gpgsign", "false");
	return dir;
}

/** Writes the bytes as a blob, with no filter, and returns its sha. */
export function writeBlob(dir: string, bytes: Uint8Array | string): string {
	const input = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
	return gitRaw(dir, ["hash-object", "-w", "--stdin", "--no-filters"], input);
}

/** A tree entry: the path as text, or as raw bytes for a path that is not UTF-8. */
export type Entry = { path: string | Uint8Array; mode: string; sha: string };

/** A commit of exactly these entries on `parent`, at FIXED_DATE unless `date` is given. */
export function commitEntries(
	dir: string,
	entries: readonly Entry[],
	parent?: string,
	date = FIXED_DATE,
): string {
	const index = path.join(dir, ".git", "export-test-index");
	rmSync(index, { force: true });
	const idx = { GIT_INDEX_FILE: index };
	gitRaw(dir, ["read-tree", "--empty"], undefined, idx);
	const lines = entries.map((e) =>
		Buffer.concat([
			Buffer.from(`${e.mode} ${e.sha}\t`, "utf8"),
			typeof e.path === "string" ? Buffer.from(e.path, "utf8") : e.path,
			Buffer.from([0]),
		]),
	);
	gitRaw(
		dir,
		["update-index", "-z", "--index-info"],
		Buffer.concat(lines),
		idx,
	);
	const tree = gitRaw(dir, ["write-tree"], undefined, idx);
	rmSync(index, { force: true });
	return gitRaw(
		dir,
		[
			"commit-tree",
			"--no-gpg-sign",
			tree,
			...(parent ? ["-p", parent] : []),
			"-m",
			"fixture",
		],
		undefined,
		{ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
	);
}

/** Text files at 100644, path to text. */
export function textFiles(dir: string, files: Record<string, string>): Entry[] {
	return Object.entries(files).map(([p, text]) => ({
		path: p,
		mode: "100644",
		sha: writeBlob(dir, text),
	}));
}
