import { ApiError } from "../../middleware/errors";

/**
 * One repository at one commit, as the repo read sees it: every file, sorted
 * by path, with its text where the extractors may need it. Both sources (the
 * GitHub tarball and a local directory) build it through toEntry, so the
 * pure functions see the same thing whichever read it.
 */
export type SnapshotEntry = {
	/** Relative to the repository root, with / separators. */
	path: string;
	/** Bytes. */
	size: number;
	/** UTF-8 text, when the file is small and text-like. Absent otherwise. */
	text?: string;
};

export type Snapshot = {
	commitSha: string;
	entries: SnapshotEntry[];
};

/** More files than this is TREE_TOO_LARGE. */
export const MAX_ENTRIES = 20_000;
/** More file bytes than this, summed, is TREE_TOO_LARGE. */
export const MAX_BYTES = 50 * 1024 * 1024;
/** A file larger than this keeps no text; it is counted, never parsed. */
export const MAX_TEXT_BYTES = 64 * 1024;

export type Limits = { entries: number; bytes: number };
export const LIMITS: Limits = { entries: MAX_ENTRIES, bytes: MAX_BYTES };

/** Directories never read: dependencies and VCS internals, not the codebase. */
const SKIPPED_DIRECTORY = /(^|\/)(node_modules|\.git|vendor|dist)\//;

/** Extensions and file names whose text the extractors use. */
const TEXT_FILE =
	/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|ya?ml|toml|py|go|rb|cfg|ini)$|(^|\/)(\.editorconfig|\.prettierrc|\.eslintrc|pre-commit|requirements[^/]*\.txt)$/;

export function isSkipped(path: string): boolean {
	return SKIPPED_DIRECTORY.test(path);
}

/** One entry from a path and its bytes. Text is kept only for small text-like files without NUL bytes. */
export function toEntry(path: string, bytes: Uint8Array): SnapshotEntry {
	const entry: SnapshotEntry = { path, size: bytes.byteLength };
	if (bytes.byteLength <= MAX_TEXT_BYTES && TEXT_FILE.test(path)) {
		if (!bytes.includes(0)) entry.text = new TextDecoder().decode(bytes);
	}
	return entry;
}

export function tooLarge(what: string): ApiError {
	return new ApiError(
		"TREE_TOO_LARGE",
		`The repository is too large to read safely: ${what}`,
	);
}

/**
 * Collects entries under the limits and sorts them by path in byte order,
 * so no locale can reorder them.
 */
export class SnapshotBuilder {
	private readonly entries: SnapshotEntry[] = [];
	private bytes = 0;

	constructor(private readonly limits: Limits = LIMITS) {}

	add(path: string, bytes: Uint8Array): void {
		if (isSkipped(path)) return;
		if (this.entries.length + 1 > this.limits.entries) {
			throw tooLarge(`more than ${this.limits.entries} files`);
		}
		this.bytes += bytes.byteLength;
		if (this.bytes > this.limits.bytes) {
			throw tooLarge(`more than ${this.limits.bytes} bytes`);
		}
		this.entries.push(toEntry(path, bytes));
	}

	build(commitSha: string): Snapshot {
		const entries = [...this.entries].sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		);
		return { commitSha, entries };
	}
}
