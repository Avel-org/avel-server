import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { COMMIT_SHA, git, gitOk } from "./git";

/**
 * Where a room's code comes from (module 7, decided 2026-10-13): the
 * mission's template at its pinned commit, or else the repository its one
 * approved intake read, at the commit read. Tier 0 resolves both to local
 * clones under AVEL_SOURCES_DIR and never fetches: the GitHub credential
 * lives only in the delivery room (SANDBOX.md), so keeping the clones
 * current is the operator's job.
 */

export type RoomSource =
	| { kind: "template"; slug: string; commit: string }
	| { kind: "repo"; repoUrl: string; commit: string };

/** Why a source cannot be resolved: an issue for source_unavailable's details. */
export type SourceIssue = {
	path: ["intake"] | ["source", "template"] | ["source", "repo"];
	message: string;
};

export type SourceResult =
	| { ok: true; repoPath: string; commit: string }
	| { ok: false; issue: SourceIssue };

/** An AppDeps gateway: local clones in production, the same over temp dirs in tests. */
export type RoomSourceResolver = {
	resolve: (source: RoomSource) => Promise<SourceResult>;
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** owner/repo from a normalized repository URL, or null when it is not one. */
export function ownerRepo(
	repoUrl: string,
): { owner: string; repo: string } | null {
	let url: URL;
	try {
		url = new URL(repoUrl);
	} catch {
		return null;
	}
	const parts = url.pathname
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (parts.length !== 2) return null;
	const [owner, repo] = parts as [string, string];
	if (!NAME.test(owner) || !NAME.test(repo) || repo.endsWith(".")) return null;
	return { owner, repo };
}

/** The clone directory a source names under `dir`, or null when its name is unsafe. */
export function cloneDir(dir: string, source: RoomSource): string | null {
	if (source.kind === "template") {
		return SLUG.test(source.slug) && !source.slug.includes("..")
			? path.join(dir, "templates", source.slug)
			: null;
	}
	const named = ownerRepo(source.repoUrl);
	return named ? path.join(dir, "repos", named.owner, named.repo) : null;
}

/** Whether two paths name one directory, through links and, on Windows, case. */
async function samePath(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([realpath(a), realpath(b)]);
	return process.platform === "win32"
		? x.toLowerCase() === y.toLowerCase()
		: x === y;
}

/**
 * Local clones under `dir` (AVEL_SOURCES_DIR): templates/<slug> and
 * repos/<owner>/<repo>. Unset, nothing resolves. A clone resolves only when
 * it is a git repository holding the commit (`git cat-file -e`).
 */
export function localSources(dir: string | undefined): RoomSourceResolver {
	return {
		resolve: async (source) => {
			const at: SourceIssue["path"] =
				source.kind === "template"
					? ["source", "template"]
					: ["source", "repo"];
			const what =
				source.kind === "template"
					? `template ${source.slug}`
					: `repository ${source.repoUrl}`;
			const fail = (message: string): SourceResult => ({
				ok: false,
				issue: { path: at, message },
			});
			if (!dir) {
				return fail(
					`AVEL_SOURCES_DIR is not set, so no local clone of ${what} at ${source.commit} can be found`,
				);
			}
			const clone = cloneDir(dir, source);
			if (!clone) return fail(`${what} has no safe local clone name`);
			if (!COMMIT_SHA.test(source.commit)) {
				return fail(`${source.commit} is not a full commit sha for ${what}`);
			}
			const isDir = await stat(clone).then(
				(s) => s.isDirectory(),
				() => false,
			);
			if (!isDir) {
				return fail(`No local clone of ${what} at ${clone}`);
			}
			const top = await git(["rev-parse", "--show-toplevel"], {
				cwd: clone,
			}).then(
				(out) => out.trim(),
				() => null,
			);
			if (top === null || !(await samePath(top, clone))) {
				return fail(`${clone} is not the root of a git repository`);
			}
			if (
				!(await gitOk(["cat-file", "-e", `${source.commit}^{commit}`], {
					cwd: clone,
				}))
			) {
				return fail(`${clone} does not hold commit ${source.commit}`);
			}
			return { ok: true, repoPath: clone, commit: source.commit };
		},
	};
}
