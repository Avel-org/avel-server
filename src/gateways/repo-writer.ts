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

/** A push of the package onto an existing branch, as one commit on its tip. */
export type PushRequest = {
	owner: string;
	repo: string;
	credentialRef: string;
	/** The branch pushed to, and the tip the package was checked against. */
	base: { branch: string; commitSha: string };
	files: readonly WriteFile[];
	deletes: readonly string[];
	message: string;
};

export type Pushed = {
	branch: string;
	/** The commit AVEL made, now the branch's tip. */
	commitSha: string;
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
	/**
	 * EXPORT-ENGINE.md §8, for a push: the same blobs, tree and commit, then
	 * updateRef on the branch, never forced. A branch that moved since its
	 * tip was read is GitHub's to refuse, and the answer is a new preview.
	 */
	pushToBranch: (request: PushRequest) => Promise<Pushed>;
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

/**
 * The blobs, tree and commit both deliveries write (EXPORT-ENGINE.md §8),
 * returning the commit's sha. Every file is checked against its gitBlobSha
 * before the first is sent; blobs go one at a time, each checked against
 * GitHub's answer; the tree always has a base. `step` names where it is.
 */
async function writeCommit(
	gh: Octokit,
	req: {
		owner: string;
		repo: string;
		base: { commitSha: string };
		files: readonly WriteFile[];
		deletes: readonly string[];
		message: string;
	},
	step: { now: string },
): Promise<string> {
	const { owner, repo } = req;
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
	step.now = "writing a file";
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
	step.now = "reading the base commit";
	const baseTree = await baseTreeOf(gh, owner, repo, req.base.commitSha);
	step.now = "writing the tree";
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
	step.now = "writing the commit";
	const commit = await gh.rest.git.createCommit({
		owner,
		repo,
		message: req.message,
		tree: tree.data.sha,
		parents: [req.base.commitSha],
	});
	return commit.data.sha;
}

/** A branch's tip, or null when GitHub has no such branch. getRef wants the short form. */
async function tipOf(
	gh: Octokit,
	owner: string,
	repo: string,
	branch: string,
): Promise<string | null> {
	const ref = await gh.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
	return ref.data.object.sha;
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
			const step = { now: "writing a file" };
			try {
				const commit = await writeCommit(gh, req, step);
				step.now = "creating the branch";
				// createRef wants the long form; it cannot repoint a ref.
				await gh.rest.git.createRef({
					owner,
					repo,
					ref: `refs/heads/${req.head}`,
					sha: commit,
				});
				step.now = "opening the pull request";
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
					commitSha: commit,
				};
			} catch (e) {
				throw writeFailure(e, step.now, named);
			}
		},
		async pushToBranch(req) {
			const gh = client(req.credentialRef);
			const { owner, repo } = req;
			const named = `${owner}/${repo}`;
			const step = { now: "writing a file" };
			let commit: string | null = null;
			try {
				commit = await writeCommit(gh, req, step);
				step.now = "moving the branch";
				// updateRef wants the short form, and is never forced: a branch
				// that moved since the preview is refused, not overwritten.
				await gh.rest.git.updateRef({
					owner,
					repo,
					ref: `heads/${req.base.branch}`,
					sha: commit,
					force: false,
				});
				return { branch: req.base.branch, commitSha: commit };
			} catch (e) {
				if (step.now === "moving the branch" && commit !== null) {
					if (statusOf(e) === 422) {
						throw new ApiError(
							"GITHUB_REJECTED",
							`GitHub refused moving ${req.base.branch} on ${named}: it moved since its tip was read. Preview again.`,
						);
					}
					// No answer: the move may have landed. Read the tip once.
					const s = statusOf(e);
					if (s === undefined || s >= 500) {
						const landed = await tipOf(gh, owner, repo, req.base.branch).catch(
							() => null,
						);
						if (landed === commit) {
							return { branch: req.base.branch, commitSha: commit };
						}
					}
				}
				throw writeFailure(e, step.now, named);
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
	return {
		openPullRequest: refuse,
		pushToBranch: refuse,
		findPullRequest: refuse,
	};
}
