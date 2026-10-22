import { VIOLATION_CODES } from "../../../contract/export";

/**
 * Inputs and output of the blast radius (docs/BLAST-RADIUS.md). The package
 * and remote-tree types are defined here until the render core and the
 * GitHub gateway land; both will produce these shapes.
 */

/** One file the delivery writes. `bytes` is its length; `blobSha` is gitBlobSha of its content. */
export type PackageFile = {
	path: string;
	/** A git file mode. Only 100644 and 100755 are delivered. */
	mode: string;
	bytes: number;
	blobSha: string;
};

/** The mission's code changes: files to write and paths to delete. */
export type DeliveryPackage = {
	files: readonly PackageFile[];
	deletes: readonly string[];
};

export type RemoteEntry = { sha: string; mode: string };

/**
 * The target branch's tree, from one recursive Git Trees call. A null
 * `commitSha` is an empty repository: no tree, and everything is a create.
 */
export type RemoteTree = {
	commitSha: string | null;
	entries: ReadonlyMap<string, RemoteEntry>;
};

export type BlastRadiusPolicy = {
	/**
	 * The mission roster's writable_paths globs. The allowed set is these plus
	 * `.avel/` (decided by J, 2026-10-21).
	 */
	writablePaths: readonly string[];
	/** A repo-policy denylist of globs, on top of `.git/` and `.github/workflows/`. */
	protectedPaths: readonly string[];
};

/** What the blast radius records about when and where it was computed. Passed in: no clock. */
export type BlastRadiusContext = {
	computedAt: string;
	baseRef: string;
	target: { owner: string; repo: string; branch: string };
};

export { VIOLATION_CODES };
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export type Violation = { code: ViolationCode; path: string; detail: string };

export type FileEntry = {
	path: string;
	mode: string;
	bytes: number;
	blobSha: string;
};

export type OverwriteEntry = FileEntry & {
	remoteBlobSha: string;
	remoteMode: string;
};

export type DeleteEntry = {
	path: string;
	remoteBlobSha: string;
	remoteMode: string;
};

export type BlastRadius = {
	computedAt: string;
	baseRef: string;
	/** Null for an empty repository. */
	baseCommitSha: string | null;
	target: { owner: string; repo: string; branch: string };

	create: FileEntry[];
	overwrite: OverwriteEntry[];
	unchanged: FileEntry[];
	delete: DeleteEntry[];

	/** Never enumerated: a count and the top-level names it covers. */
	preserveSummary: {
		fileCount: number;
		topLevelDirs: string[];
	};

	violations: Violation[];

	totals: {
		create: number;
		overwrite: number;
		unchanged: number;
		delete: number;
		violations: number;
	};
};
