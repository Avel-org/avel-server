import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type {
	BranchTree,
	RepoSource,
	SnapshotRequest,
	TreeRequest,
} from "../../src/gateways/repo-source";
import type {
	FoundPullRequest,
	PullRequestRequest,
	PushRequest,
	RepoWriter,
} from "../../src/gateways/repo-writer";
import type { Snapshot } from "../../src/lib/repo-read/snapshot";
import { snapshotFromTarball } from "../../src/lib/repo-read/tar";
import { ApiError } from "../../src/middleware/errors";

// The repo-read fixtures: real small trees, snapshotted to JSON by
// scripts/repo-fixture.ts. Not collected as a test file.

export const FIXTURES = [
	"nest-feature",
	"express-layer",
	"mixed-cut",
	"competing-tests",
	"bare-layer",
	"monorepo",
] as const;

export function fixture(name: (typeof FIXTURES)[number]): Snapshot {
	return JSON.parse(
		readFileSync(`tests/fixtures/repo-read/${name}.json`, "utf8"),
	) as Snapshot;
}

/**
 * The Snapshot of one commit of a local clone, read the way a GitHub
 * tarball is: `git archive` under one top-level directory, gzipped, through
 * snapshotFromTarball. So an intake that reads it records that commit.
 */
export function snapshotOfCommit(dir: string, commit: string): Snapshot {
	const tarball = execFileSync(
		"git",
		[
			"-c",
			"core.autocrlf=false",
			"archive",
			"--format=tar",
			`--prefix=snapshot-${commit}/`,
			commit,
		],
		{ cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
	);
	return snapshotFromTarball(new Uint8Array(gzipSync(tarball)), commit);
}

/** For apps that never read a repository. A test that does fails loudly. */
export const noRepos: RepoSource = {
	hasCredential: () => true,
	snapshot: async () => {
		throw new Error("this test has no repository source; pass repos");
	},
	tree: async () => {
		throw new Error("this test has no repository source; pass repos");
	},
};

/**
 * A RepoSource serving snapshots by "owner/repo", with the credentials
 * `credentials` names. An unknown repository answers REPO_NOT_FOUND, as
 * GitHub would; a value that is an ApiError is thrown as that failure.
 * Branch trees come from `trees` by "owner/repo" the same way; a tree
 * answers for whichever branch is asked, as that branch.
 */
export function fixtureRepos(
	repos: Record<string, Snapshot | ApiError>,
	credentials: readonly string[] = ["MERIDIAN_GITHUB_TOKEN"],
	trees: Record<string, BranchTree | ApiError> = {},
): RepoSource & { requests: SnapshotRequest[]; treeRequests: TreeRequest[] } {
	const requests: SnapshotRequest[] = [];
	const treeRequests: TreeRequest[] = [];
	return {
		requests,
		treeRequests,
		hasCredential: (ref) => credentials.includes(ref),
		snapshot: async (req) => {
			requests.push(req);
			const found = repos[`${req.owner}/${req.repo}`];
			if (found instanceof ApiError) throw found;
			if (!found)
				throw new ApiError(
					"REPO_NOT_FOUND",
					`No fixture for ${req.owner}/${req.repo}`,
				);
			return found;
		},
		tree: async (req) => {
			treeRequests.push(req);
			const found = trees[`${req.owner}/${req.repo}`];
			if (found instanceof ApiError) throw found;
			if (!found)
				throw new ApiError(
					"REPO_NOT_FOUND",
					`No tree fixture for ${req.owner}/${req.repo}`,
				);
			return { ...found, branch: req.branch ?? found.branch };
		},
	};
}

/**
 * A RepoWriter that records what it is asked and answers from `script`:
 * openPullRequest with PR number 42 (or throws `fail`), findPullRequest
 * with `found` when its branch is the one asked for, else null, and
 * pushToBranch with commit 888… (or throws `pushFails`).
 */
export function recordingWriter(
	script: {
		fail?: ApiError;
		found?: FoundPullRequest | null;
		/** Runs inside openPullRequest, before it answers: a slow GitHub. */
		during?: (req: PullRequestRequest) => Promise<void>;
		/** findPullRequest throws this, as GitHub not answering. */
		findFails?: ApiError;
		/** pushToBranch throws this. */
		pushFails?: ApiError;
	} = {},
): RepoWriter & {
	opened: PullRequestRequest[];
	pushed: PushRequest[];
	finds: Array<{ owner: string; repo: string; head: string }>;
	script: typeof script;
} {
	const opened: PullRequestRequest[] = [];
	const pushed: PushRequest[] = [];
	const finds: Array<{ owner: string; repo: string; head: string }> = [];
	return {
		opened,
		pushed,
		finds,
		script,
		async pushToBranch(req) {
			pushed.push(req);
			if (script.pushFails) throw script.pushFails;
			return { branch: req.base.branch, commitSha: "8".repeat(40) };
		},
		async openPullRequest(req) {
			// As createRef does: a branch that exists is never repointed.
			const taken = opened.some((o) => o.head === req.head);
			opened.push(req);
			if (taken) {
				throw new ApiError(
					"GITHUB_REJECTED",
					`GitHub refused creating the branch on ${req.owner}/${req.repo}: a branch of that name may already exist`,
				);
			}
			await script.during?.(req);
			if (script.fail) throw script.fail;
			return {
				number: 42,
				url: `https://github.com/${req.owner}/${req.repo}/pull/42`,
				branch: req.head,
				commitSha: "9".repeat(40),
			};
		},
		async findPullRequest(req) {
			finds.push({ owner: req.owner, repo: req.repo, head: req.head });
			if (script.findFails) throw script.findFails;
			// As GitHub does: a PR is found only by its own branch.
			return script.found?.branch === req.head ? script.found : null;
		},
	};
}
