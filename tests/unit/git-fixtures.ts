import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Temp directories and git repositories for the room tests. Every git call
// pins core.autocrlf=false, like src/rooms/git.ts, so the tests do not
// depend on the machine's line-ending settings. Not collected as a test file.

export function tempDir(label: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), `avel-${label}-`)));
}

export function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

export function gitIn(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
		{ cwd, encoding: "utf8", windowsHide: true },
	).trim();
}

/** Writes files (path → text) under `root`, making directories. */
export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		const target = path.join(root, ...rel.split("/"));
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, text, "utf8");
	}
}

/**
 * A git repository at `dir` with one commit of `files`, and a second
 * commit when `next` is given. Returns the commits, oldest first.
 */
export function makeRepo(
	dir: string,
	files: Record<string, string>,
	next?: Record<string, string>,
): string[] {
	mkdirSync(dir, { recursive: true });
	gitIn(dir, "init", "--quiet", "--initial-branch=main");
	gitIn(dir, "config", "user.email", "rooms@example.com");
	gitIn(dir, "config", "user.name", "Room tests");
	gitIn(dir, "config", "commit.gpgsign", "false");
	const commits: string[] = [];
	for (const batch of next ? [files, next] : [files]) {
		writeFiles(dir, batch);
		gitIn(dir, "add", "--all");
		gitIn(dir, "commit", "--quiet", "-m", `commit ${commits.length + 1}`);
		commits.push(gitIn(dir, "rev-parse", "HEAD"));
	}
	return commits;
}
