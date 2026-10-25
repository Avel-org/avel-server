import { Octokit } from "@octokit/rest";
import type { RemoteEntry, RemoteTree } from "../lib/export/delivery/types";
import type { Snapshot } from "../lib/repo-read/snapshot";
import { snapshotFromTarball } from "../lib/repo-read/tar";
import { ApiError } from "../middleware/errors";

export type SnapshotRequest = {
	owner: string;
	repo: string;
	/** A branch, tag or sha. Omitted: the default branch's head. */
	ref?: string;
	/** The env var name a Connection names (Connection.credential_ref). */
	credentialRef: string;
};

export type TreeRequest = {
	owner: string;
	repo: string;
	/** A branch name. Omitted: the repository's default branch. */
	branch?: string;
	credentialRef: string;
};

/**
 * A branch's tree at its tip, which branch that was, and the repository's
 * default branch (a push to it needs RepoPolicy). A null commitSha is an
 * empty repository.
 */
export type BranchTree = RemoteTree & { branch: string; defaultBranch: string };

/**
 * Where the repo read gets a repository from. An AppDeps gateway: production
 * reads GitHub, tests pass a fake that serves fixtures. A token never leaves
 * the gateway; callers name a credential, and the gateway resolves it.
 */
export type RepoSource = {
	/** Whether the named credential resolves now. Checked at read time, never at create. */
	hasCredential: (credentialRef: string) => boolean;
	/** One commit, pinned by sha, as a Snapshot. Fails with the BLAST-RADIUS repository codes. */
	snapshot: (request: SnapshotRequest) => Promise<Snapshot>;
	/**
	 * A branch's whole tree at its tip, from one recursive Git Trees call
	 * (BLAST-RADIUS.md, Reading the remote tree): paths, modes and object
	 * shas, no bytes. An empty repository answers commitSha null. A missing
	 * branch is BRANCH_NOT_FOUND; a truncated tree is TREE_TOO_LARGE.
	 */
	tree: (request: TreeRequest) => Promise<BranchTree>;
};

function statusOf(e: unknown): number | undefined {
	if (typeof e === "object" && e !== null && "status" in e) {
		const s = (e as { status: unknown }).status;
		return typeof s === "number" ? s : undefined;
	}
	return undefined;
}

/**
 * GitHub's answer as one of the repository codes. The message names the
 * repository and never carries the token or GitHub's response body.
 */
export function githubFailure(e: unknown, req: SnapshotRequest): ApiError {
	if (e instanceof ApiError) return e;
	const repo = `${req.owner}/${req.repo}`;
	switch (statusOf(e)) {
		case 401:
		case 403:
			return new ApiError(
				"REPO_NO_ACCESS",
				`The credential ${req.credentialRef} cannot read ${repo}`,
			);
		case 404:
			return new ApiError(
				"REPO_NOT_FOUND",
				`GitHub has no repository ${repo} that this credential can see`,
			);
		case 409:
			return new ApiError("EMPTY_REPOSITORY", `${repo} has no commits`);
		case 422:
			return new ApiError(
				"BRANCH_NOT_FOUND",
				`${repo} has no commit at ${req.ref ?? "its default branch"}`,
			);
		default:
			return new ApiError(
				"EXTERNAL_GITHUB",
				`GitHub did not answer the read of ${repo}`,
			);
	}
}

/**
 * Reads GitHub: the commit sha first, then the tarball at exactly that sha,
 * so the snapshot is the commit it names. `env` resolves credential names
 * (process.env in production); `fetch` is replaceable so tests can drive
 * GitHub's error statuses without the network.
 */
export function githubRepoSource(options: {
	env: (name: string) => string | undefined;
	fetch?: typeof fetch;
}): RepoSource {
	return {
		hasCredential: (ref) => {
			const value = options.env(ref);
			return value !== undefined && value !== "";
		},
		snapshot: async (req) => {
			const token = options.env(req.credentialRef);
			if (!token) {
				throw new Error(`credential ${req.credentialRef} is not set`);
			}
			const gh = new Octokit({
				auth: token,
				request: options.fetch ? { fetch: options.fetch } : undefined,
			});
			try {
				const commit = await gh.rest.repos.getCommit({
					owner: req.owner,
					repo: req.repo,
					ref: req.ref ?? "HEAD",
				});
				const sha = commit.data.sha;
				const archive = await gh.rest.repos.downloadTarballArchive({
					owner: req.owner,
					repo: req.repo,
					ref: sha,
				});
				const snapshot = snapshotFromTarball(
					new Uint8Array(archive.data as ArrayBuffer),
					sha,
				);
				if (snapshot.entries.length === 0) {
					throw new ApiError(
						"EMPTY_REPOSITORY",
						`${req.owner}/${req.repo} has no files at ${sha}`,
					);
				}
				return snapshot;
			} catch (e) {
				throw githubFailure(e, req);
			}
		},
		tree: async (req) => {
			const token = options.env(req.credentialRef);
			if (!token) {
				throw new Error(`credential ${req.credentialRef} is not set`);
			}
			const gh = new Octokit({
				auth: token,
				request: options.fetch ? { fetch: options.fetch } : undefined,
			});
			const named = `${req.owner}/${req.repo}`;
			try {
				// The repository first, so a missing one is REPO_NOT_FOUND and
				// never a missing branch.
				const repo = await gh.rest.repos.get({
					owner: req.owner,
					repo: req.repo,
				});
				const defaultBranch = repo.data.default_branch;
				const branch = req.branch ?? defaultBranch;
				let commitSha: string;
				try {
					const ref = await gh.rest.git.getRef({
						owner: req.owner,
						repo: req.repo,
						ref: `heads/${branch}`,
					});
					if (ref.data.object.type !== "commit") {
						throw new ApiError(
							"BRANCH_NOT_FOUND",
							`${named} has no branch ${branch}`,
						);
					}
					commitSha = ref.data.object.sha;
				} catch (e) {
					if (statusOf(e) === 409) {
						return {
							branch,
							defaultBranch,
							commitSha: null,
							entries: new Map(),
						};
					}
					if (statusOf(e) === 404) {
						throw new ApiError(
							"BRANCH_NOT_FOUND",
							`${named} has no branch ${branch}`,
						);
					}
					throw e;
				}
				const commit = await gh.rest.git.getCommit({
					owner: req.owner,
					repo: req.repo,
					commit_sha: commitSha,
				});
				const tree = await gh.rest.git.getTree({
					owner: req.owner,
					repo: req.repo,
					tree_sha: commit.data.tree.sha,
					recursive: "true",
				});
				if (tree.data.truncated) {
					throw new ApiError(
						"TREE_TOO_LARGE",
						`GitHub truncated the tree of ${named} at ${commitSha}`,
					);
				}
				const entries = new Map<string, RemoteEntry>();
				for (const e of tree.data.tree) {
					if (e.path && e.mode && e.sha) {
						entries.set(e.path, { sha: e.sha, mode: e.mode });
					}
				}
				return { branch, defaultBranch, commitSha, entries };
			} catch (e) {
				throw githubFailure(e, {
					owner: req.owner,
					repo: req.repo,
					ref: req.branch,
					credentialRef: req.credentialRef,
				});
			}
		},
	};
}
