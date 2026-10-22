import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type {
	RepoSource,
	SnapshotRequest,
} from "../../src/gateways/repo-source";
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
};

/**
 * A RepoSource serving snapshots by "owner/repo", with the credentials
 * `credentials` names. An unknown repository answers REPO_NOT_FOUND, as
 * GitHub would; a value that is an ApiError is thrown as that failure.
 */
export function fixtureRepos(
	repos: Record<string, Snapshot | ApiError>,
	credentials: readonly string[] = ["MERIDIAN_GITHUB_TOKEN"],
): RepoSource & { requests: SnapshotRequest[] } {
	const requests: SnapshotRequest[] = [];
	return {
		requests,
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
	};
}
