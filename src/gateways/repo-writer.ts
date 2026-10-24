import { Octokit } from "@octokit/rest";
import { gitBlobSha } from "../lib/export/blob";
import { ApiError } from "../middleware/errors";

/** One file of the package, with the bytes GitHub is sent. */
export type WriteFile = {
	path: string;
	/** 100644 or 100755. */
	mode: string;
	bytes: Uint8Array;
	/** gitBlobSha of bytes; GitHub's answer must equal it. */
	blobSha: string;
};

export type PullRequestRequest = {
	owner: string;
	repo: string;
	/** The env var name a Connection names (Connection.credential_ref). */
	credentialRef: string;
	/** The branch the PR goes into, and the tip the package was checked against. */
	base: { branch: string; commitSha: string };
	/** The new branch the commit goes on. createRef never repoints one. */
	head: string;
	files: readonly WriteFile[];
	deletes: readonly string[];
	message: string;
	title: string;
	body: string;
};

export type OpenedPullRequest = {
	number: number;
	url: string;
	branch: string;
	/** The commit AVEL made on the branch. */
	commitSha: string;
};

export type PullRequestState = "open" | "merged" | "closed";

export type FoundPullRequest = OpenedPullRequest & { state: PullRequestState };

export type RepoWriter = {
	/**
	 * EXPORT-ENGINE.md §8, for a pull request: a blob per file, one at a
	 * time, each checked against its gitBlobSha; a tree on the base commit's
	 * tree; a commit on the base commit; a new branch; the PR.
	 */
	openPullRequest: (request: PullRequestRequest) => Promise<OpenedPullRequest>;
	/** The open or closed PR whose head is `head` in the repository, or null. */
	findPullRequest: (request: {
		owner: string;
		repo: string;
		credentialRef: string;
		head: string;
	}) => Promise<FoundPullRequest | null>;
};

function statusOf(e: unknown): number | undefined {
	if (typeof e === "object" && e !== null && "status" in e) {
		const s = (e as { status: unknown }).status;
		return typeof s === "number" ? s : undefined;
	}
	return undefined;
}

/**
 * A GitHub write failure as AVEL's error. A status GitHub answered with is
 * GITHUB_REJECTED (retrying the same request will not help); no answer is
 * EXTERNAL_GITHUB. The message is the server's own, never GitHub's body.
 */
export function writeFailure(e: unknown, step: string, repo: string): ApiError {
	if (e instanceof ApiError) return e;
	const status = statusOf(e);
	// GitHub's rate limits answer 403 or 429, with these headers or, for the
	// secondary limit, only its message: a wait, not a credential that
	// cannot write.
	const headers = headersOf(e);
	if (
		(status === 403 || status === 429) &&
		(headers["x-ratelimit-remaining"] === "0" ||
			"retry-after" in headers ||
			status === 429 ||
			/rate limit/i.test(e instanceof Error ? e.message : ""))
	) {
		const after = headers["retry-after"];
		return new ApiError(
			"EXTERNAL_GITHUB",
			`GitHub's rate limit refused ${step} on ${repo}${after ? `; try again in ${after} s` : "; try again later"}`,
		);
	}
	if (status === undefined || status >= 500) {
		return new ApiError(
			"EXTERNAL_GITHUB",
			`GitHub did not answer while ${step} on ${repo}`,
		);
	}
	const why =
		status === 401 || status === 403
			? "the credential cannot write to it"
			: status === 404
				? "GitHub could not find what it was asked for"
				: status === 422
					? "GitHub refused it as invalid; a branch of that name may already exist"
					: `GitHub answered ${status}`;
	return new ApiError(
		"GITHUB_REJECTED",
		`GitHub refused ${step} on ${repo}: ${why}`,
	);
}

/**
 * The base_tree for createTree (EXPORT-ENGINE.md §8). A pull request needs
 * a base branch with a commit, so it is never null here, and createTree is
 * never called without it. A commit sha is not a tree sha: this is the base
 * commit's own tree, through getCommit.
 */
async function baseTreeOf(
	gh: Octokit,
	owner: string,
	repo: string,
	commitSha: string,
): Promise<string> {
	const commit = await gh.rest.git.getCommit({
		owner,
		repo,
		commit_sha: commitSha,
	});
	return commit.data.tree.sha;
}

function headersOf(e: unknown): Record<string, string> {
	if (typeof e === "object" && e !== null && "response" in e) {
		const r = (e as { response?: { headers?: Record<string, unknown> } })
			.response;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(r?.headers ?? {})) {
			if (typeof v === "string" || typeof v === "number") {
				out[k.toLowerCase()] = String(v);
			}
		}
		return out;
	}
	return {};
}

function stateOf(pr: { state: string; merged_at: string | null }) {
	if (pr.merged_at) return "merged" as const;
	return pr.state === "open" ? ("open" as const) : ("closed" as const);
}

/**
 * Writes to GitHub. `env` resolves credential names (process.env in
 * production); `fetch` is replaceable so tests drive GitHub without the
 * network.
 */
export function githubRepoWriter(options: {
	env: (name: string) => string | undefined;
	fetch?: typeof fetch;
}): RepoWriter {
	const client = (credentialRef: string) => {
		const token = options.env(credentialRef);
		if (!token) throw new Error(`credential ${credentialRef} is not set`);
		return new Octokit({
			auth: token,
			request: options.fetch ? { fetch: options.fetch } : undefined,
		});
	};
	return {
		async openPullRequest(req) {
			const gh = client(req.credentialRef);
			const { owner, repo } = req;
			const named = `${owner}/${repo}`;
			let step = "writing a file";
			try {
				// AVEL's render disagreeing with itself: every file is checked
				// before the first is sent, so nothing reaches the repository.
				for (const f of req.files) {
					if (gitBlobSha(f.bytes) !== f.blobSha) {
						throw new ApiError(
							"DETERMINISM_VIOLATION",
							`${f.path} was rendered as ${f.blobSha}, but its bytes hash to ${gitBlobSha(f.bytes)}`,
						);
					}
				}
				// One at a time: GitHub's secondary rate limit counts
				// concurrency, and a half-written package is the cost.
				for (const f of req.files) {
					const blob = await gh.rest.git.createBlob({
						owner,
						repo,
						content: Buffer.from(f.bytes).toString("base64"),
						encoding: "base64",
					});
					if (blob.data.sha !== f.blobSha) {
						throw new ApiError(
							"GITHUB_REJECTED",
							`GitHub stored ${f.path} as ${blob.data.sha}, not ${f.blobSha}: it is not the file AVEL rendered`,
						);
					}
				}
				step = "reading the base commit";
				const baseTree = await baseTreeOf(gh, owner, repo, req.base.commitSha);
				step = "writing the tree";
				const tree = await gh.rest.git.createTree({
					owner,
					repo,
					// Never omitted: a tree without a base deletes every file
					// the package does not list.
					base_tree: baseTree,
					tree: [
						...req.files.map((f) => ({
							path: f.path,
							mode: f.mode as "100644" | "100755",
							type: "blob" as const,
							sha: f.blobSha,
						})),
						// A null sha removes the path from the base tree.
						...req.deletes.map((path) => ({
							path,
							mode: "100644" as const,
							type: "blob" as const,
							sha: null,
						})),
					],
				});
				step = "writing the commit";
				const commit = await gh.rest.git.createCommit({
					owner,
					repo,
					message: req.message,
					tree: tree.data.sha,
					parents: [req.base.commitSha],
				});
				step = "creating the branch";
				// createRef wants the long form; it cannot repoint a ref.
				await gh.rest.git.createRef({
					owner,
					repo,
					ref: `refs/heads/${req.head}`,
					sha: commit.data.sha,
				});
				step = "opening the pull request";
				const pr = await gh.rest.pulls.create({
					owner,
					repo,
					title: req.title,
					body: req.body,
					head: req.head,
					base: req.base.branch,
				});
				return {
					number: pr.data.number,
					url: pr.data.html_url,
					branch: req.head,
					commitSha: commit.data.sha,
				};
			} catch (e) {
				throw writeFailure(e, step, named);
			}
		},
		async findPullRequest(req) {
			const gh = client(req.credentialRef);
			try {
				const list = await gh.rest.pulls.list({
					owner: req.owner,
					repo: req.repo,
					head: `${req.owner}:${req.head}`,
					state: "all",
					per_page: 1,
				});
				const pr = list.data[0];
				if (!pr) return null;
				return {
					number: pr.number,
					url: pr.html_url,
					branch: req.head,
					commitSha: pr.head.sha,
					state: stateOf(pr),
				};
			} catch (e) {
				throw writeFailure(
					e,
					"reading the pull request",
					`${req.owner}/${req.repo}`,
				);
			}
		},
	};
}

/**
 * A writer that never writes: for an app built where no GitHub delivery
 * may happen (avel-web's tests, the unit harness). Every call refuses.
 */
export function noRepoWriter(): RepoWriter {
	const refuse = async (): Promise<never> => {
		throw new ApiError("EXTERNAL_GITHUB", "This server has no GitHub writer");
	};
	return { openPullRequest: refuse, findPullRequest: refuse };
}
