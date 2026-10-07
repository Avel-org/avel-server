import { Octokit } from "@octokit/rest";
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
	};
}
