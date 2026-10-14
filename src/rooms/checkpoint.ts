import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError } from "../middleware/errors";
import { git } from "./git";
import { writable } from "./globs";

/**
 * The exit checkpoint (SANDBOX.md, Pattern boundaries): the one door an
 * agent's work leaves a room through. Every path changed since the room's
 * pinned commit is checked against the entry's writable globs. Step 8
 * calls it when the agent reports complete or blocked.
 */

export type FileChange =
	| { kind: "added" | "modified" | "deleted"; path: string }
	| { kind: "renamed"; from: string; path: string };

const KINDS: Record<string, FileChange["kind"] | undefined> = {
	A: "added",
	M: "modified",
	T: "modified",
	D: "deleted",
	R: "renamed",
};

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(out: string): FileChange[] {
	const fields = out.split("\0");
	const changes: FileChange[] = [];
	let i = 0;
	while (i < fields.length) {
		const status = fields[i] ?? "";
		if (status === "") {
			i += 1;
			continue;
		}
		const kind = KINDS[status[0] ?? ""];
		if (!kind) throw new Error(`unexpected git status ${status}`);
		if (kind === "renamed") {
			changes.push({
				kind,
				from: fields[i + 1] ?? "",
				path: fields[i + 2] ?? "",
			});
			i += 3;
		} else {
			changes.push({ kind, path: fields[i + 1] ?? "" });
			i += 2;
		}
	}
	return changes.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

/**
 * Every path changed in the room since `commit`: added, modified, deleted
 * and renamed (with both paths), untracked and ignored files included, so
 * a write to a gitignored path is still seen. Built in a throwaway index,
 * so the room's own index is never touched. Sorted by path.
 */
export async function changedFiles(
	root: string,
	commit: string,
): Promise<FileChange[]> {
	const scratch = await mkdtemp(path.join(tmpdir(), "avel-checkpoint-"));
	const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
	try {
		await git(["read-tree", commit], { cwd: root, env });
		await git(["add", "--all", "--force", "--", "."], { cwd: root, env });
		const out = await git(
			["diff", "--cached", "--name-status", "-z", "-M", commit],
			{ cwd: root, env },
		);
		return parseNameStatus(out);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export type CheckpointIssue = {
	path: ["files", number];
	message: string;
};

/**
 * One issue per path outside the writable globs, at ["files", i] where i
 * indexes `changes`: a rename is checked at both its paths. Pure, and in
 * the order of `changes`, then the old path before the new.
 */
export function checkpointIssues(
	changes: readonly FileChange[],
	writableGlobs: readonly string[],
): CheckpointIssue[] {
	const issues: CheckpointIssue[] = [];
	changes.forEach((c, i) => {
		const paths = c.kind === "renamed" ? [c.from, c.path] : [c.path];
		for (const p of paths) {
			if (!writable(p, writableGlobs)) {
				issues.push({
					path: ["files", i],
					message: `${p} (${c.kind}) is outside the writable paths`,
				});
			}
		}
	});
	return issues;
}

/**
 * The checkpoint itself: the changed-file list when every path is inside
 * the writable globs; otherwise 422 writes_outside_mount with the issues.
 */
export async function exitCheckpoint(room: {
	root: string;
	commit: string;
	writableGlobs: readonly string[];
	dispatchId: string;
}): Promise<FileChange[]> {
	const changes = await changedFiles(room.root, room.commit);
	const issues = checkpointIssues(changes, room.writableGlobs);
	if (issues.length > 0) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"The work changes files outside the agent's writable paths",
			{
				details: {
					reason: "writes_outside_mount",
					dispatchId: room.dispatchId,
					issues,
				},
			},
		);
	}
	return changes;
}
