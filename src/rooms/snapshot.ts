import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntegrationPlan } from "../lib/gate/integration";
import { type FileChange, parseNameStatus } from "./checkpoint";
import { COMMIT_SHA, git } from "./git";
import { lsTreeBlobs } from "./read-set";

/**
 * Dispatch commits and the integration commit (module 9, decided
 * 2026-10-19): git plumbing against the local source clone only. Nothing
 * fetches, nothing needs a credential, and every index is a scratch one, so
 * neither a room's index and HEAD nor the clone's are ever touched.
 *
 * Commits are made by one fixed identity at a date taken from the
 * dispatch's closedAt, without signing, so the same bytes at the same time
 * always make the same sha.
 */

export const AVEL_IDENTITY = { name: "AVEL", email: "avel@localhost" } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Where a dispatch's commit is kept, so releasing its room cannot lose it. */
export function dispatchRef(dispatchId: string): string {
	return `refs/avel/dispatches/${dispatchId}`;
}

/** A git date in its raw form, `<seconds> +0000`, from an ISO instant. */
function gitDate(iso: string): string {
	return `${Math.floor(Date.parse(iso) / 1000)} +0000`;
}

function commitEnv(
	base: NodeJS.ProcessEnv,
	closedAtIso: string,
): NodeJS.ProcessEnv {
	const date = gitDate(closedAtIso);
	return {
		...base,
		GIT_AUTHOR_NAME: AVEL_IDENTITY.name,
		GIT_AUTHOR_EMAIL: AVEL_IDENTITY.email,
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_NAME: AVEL_IDENTITY.name,
		GIT_COMMITTER_EMAIL: AVEL_IDENTITY.email,
		GIT_COMMITTER_DATE: date,
	};
}

/** Runs `fn` with a throwaway index file, removed afterwards. */
async function withScratchIndex<T>(
	fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
	const scratch = await mkdtemp(path.join(tmpdir(), "avel-index-"));
	try {
		return await fn({
			...process.env,
			GIT_INDEX_FILE: path.join(scratch, "index"),
		});
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function commitTree(
	cwd: string,
	env: NodeJS.ProcessEnv,
	tree: string,
	parent: string,
	message: string,
	closedAtIso: string,
): Promise<string> {
	const sha = await git(
		["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-m", message],
		{ cwd, env: commitEnv(env, closedAtIso) },
	);
	return sha.trim();
}

/**
 * The room's state as a commit on the pinned commit: everything the exit
 * checkpoint saw, untracked and ignored files included. The commit is kept
 * at refs/avel/dispatches/<dispatchId> in the source clone.
 */
export async function snapshotDispatch(
	room: { root: string; repoPath: string },
	pinnedSha: string,
	dispatchId: string,
	closedAtIso: string,
): Promise<string> {
	if (!UUID.test(dispatchId)) throw new Error(`No dispatch ${dispatchId}`);
	if (!COMMIT_SHA.test(pinnedSha)) {
		throw new Error(`The pinned commit ${pinnedSha} is not a full sha`);
	}
	if (!ISO.test(closedAtIso)) throw new Error(`closedAt ${closedAtIso}`);
	const sha = await commitRoom(
		room.root,
		pinnedSha,
		`dispatch ${dispatchId}`,
		closedAtIso,
	);
	await git(["update-ref", dispatchRef(dispatchId), sha], {
		cwd: room.repoPath,
	});
	return sha;
}

/**
 * The room's state as a commit on the pinned commit, as snapshotDispatch
 * makes it, but kept under no ref: what an agent's run_checks runs on. A
 * worktree writes its objects to the source clone's store, so a runner
 * reading the clone finds it. Unreferenced, git's gc may remove it after
 * its prune grace (two weeks by default); nothing reads it after the run.
 */
export async function snapshotRoomForChecks(
	room: { root: string },
	pinnedSha: string,
	dispatchId: string,
	atIso: string,
): Promise<string> {
	if (!UUID.test(dispatchId)) throw new Error(`No dispatch ${dispatchId}`);
	if (!COMMIT_SHA.test(pinnedSha)) {
		throw new Error(`The pinned commit ${pinnedSha} is not a full sha`);
	}
	if (!ISO.test(atIso)) throw new Error(`at ${atIso}`);
	return commitRoom(room.root, pinnedSha, `checks ${dispatchId}`, atIso);
}

/** Everything in the room, untracked and ignored files included, committed on `pinnedSha`. */
function commitRoom(
	root: string,
	pinnedSha: string,
	message: string,
	atIso: string,
): Promise<string> {
	return withScratchIndex(async (env) => {
		await git(["read-tree", pinnedSha], { cwd: root, env });
		await git(["add", "--all", "--force", "--", "."], { cwd: root, env });
		const tree = (await git(["write-tree"], { cwd: root, env })).trim();
		return commitTree(root, env, tree, pinnedSha, message, atIso);
	});
}

/**
 * What a dispatch commit changed from the pinned commit, with the same
 * rename detection (-M) and parser as the exit checkpoint.
 */
export async function dispatchChanges(
	source: string,
	pinnedSha: string,
	resultSha: string,
): Promise<FileChange[]> {
	const out = await git(
		["diff-tree", "-r", "-z", "-M", "--name-status", pinnedSha, resultSha],
		{ cwd: source },
	);
	return parseNameStatus(out);
}

/**
 * Why an integration commit was refused. Not yet PRECONDITION_REASONS in the
 * contract; the gate route maps each to a 422 once they are added there.
 */
export const INTEGRATION_REFUSALS = [
	"integration_conflict",
	"nothing_to_judge",
	"dispatch_commit_missing",
	"dispatch_commit_off_base",
	"plan_mismatch",
] as const;

export type IntegrationRefusal = (typeof INTEGRATION_REFUSALS)[number];

export class IntegrationRefused extends Error {
	constructor(
		message: string,
		readonly details: { reason: IntegrationRefusal } & Record<string, unknown>,
	) {
		super(message);
		this.name = "IntegrationRefused";
	}
}

const refuse = (
	message: string,
	details: { reason: IntegrationRefusal } & Record<string, unknown>,
) => new IntegrationRefused(message, details);

/**
 * The commit the gate judges: the plan's steps laid onto its base in a
 * scratch index, each write taken from that step's dispatch commit, by AVEL
 * at the last step's closedAt. Refused (IntegrationRefused) for a conflict, an empty plan,
 * a missing dispatch commit, one made on another base, or a write its
 * dispatch commit does not hold.
 */
export async function buildIntegrationCommit(
	source: string,
	plan: IntegrationPlan,
): Promise<{ sha: string }> {
	if (!plan.ok) {
		throw refuse("Two dispatches changed the same paths", {
			reason: "integration_conflict",
			conflicts: plan.conflicts,
		});
	}
	const last = plan.steps.at(-1);
	if (!last) {
		throw refuse("No complete dispatch to judge", {
			reason: "nothing_to_judge",
		});
	}

	const commits = new Map<string, string>();
	for (const step of plan.steps) {
		const ref = dispatchRef(step.dispatchId);
		let sha: string;
		let parent: string;
		try {
			sha = (
				await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: source })
			).trim();
			parent = (
				await git(["rev-parse", "--verify", `${sha}^`], { cwd: source })
			).trim();
		} catch {
			throw refuse("A dispatch has no commit to integrate", {
				reason: "dispatch_commit_missing",
				dispatchId: step.dispatchId,
			});
		}
		if (parent !== plan.baseSha) {
			throw refuse("A dispatch's commit is not on the mission's base", {
				reason: "dispatch_commit_off_base",
				dispatchId: step.dispatchId,
			});
		}
		commits.set(step.dispatchId, sha);
	}

	return withScratchIndex(async (env) => {
		await git(["read-tree", plan.baseSha], { cwd: source, env });
		for (const step of plan.steps) {
			const from = commits.get(step.dispatchId) as string;
			for (const op of step.ops) {
				if (op.op === "delete") {
					await git(["update-index", "--force-remove", "--", op.path], {
						cwd: source,
						env,
					});
					continue;
				}
				const entry = (
					await git(["ls-tree", "-z", from, "--", op.path], { cwd: source })
				).split("\0")[0];
				const tab = entry?.indexOf("\t") ?? -1;
				if (!entry || tab < 0 || entry.slice(tab + 1) !== op.path) {
					throw refuse("The plan writes a path its dispatch did not leave", {
						reason: "plan_mismatch",
						dispatchId: step.dispatchId,
						path: op.path,
					});
				}
				const [mode, , blob] = entry.slice(0, tab).split(" ");
				await git(
					[
						"update-index",
						"--add",
						"--cacheinfo",
						`${mode},${blob},${op.path}`,
					],
					{ cwd: source, env },
				);
			}
		}
		const tree = (await git(["write-tree"], { cwd: source, env })).trim();
		const sha = await commitTree(
			source,
			env,
			tree,
			plan.baseSha,
			`integration of ${plan.steps.map((s) => s.dispatchId).join(", ")}`,
			last.closedAt,
		);
		return { sha };
	});
}

/**
 * A commit's blobs, path to blob sha, read from git's tree. Symlinks and
 * submodules are left out, as lsTreeBlobs leaves them out for rooms.
 */
export async function readTree(
	source: string,
	sha: string,
): Promise<Record<string, string>> {
	const listing = await git(["ls-tree", "-r", "-z", "--full-tree", sha], {
		cwd: source,
	});
	const tree: Record<string, string> = {};
	for (const f of lsTreeBlobs(listing)) tree[f.path] = f.blobSha;
	return tree;
}

export type PackageJsonScripts =
	| { kind: "absent" }
	| { kind: "scripts"; scripts: Record<string, string> }
	/** The caller then protects "package.json" whole (protectedPathFindings). */
	| { kind: "unparseable"; reason: string };

/** The root package.json's `scripts` at a commit. */
export async function readPackageJsonScripts(
	source: string,
	sha: string,
): Promise<PackageJsonScripts> {
	const listed = await git(["ls-tree", "-z", sha, "--", "package.json"], {
		cwd: source,
	});
	if (listed === "") return { kind: "absent" };
	const text = await git(["show", `${sha}:package.json`], { cwd: source });
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "unparseable", reason: "package.json is not JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "unparseable", reason: "package.json is not an object" };
	}
	const scripts = (parsed as { scripts?: unknown }).scripts;
	if (scripts === undefined) return { kind: "scripts", scripts: {} };
	if (
		scripts === null ||
		typeof scripts !== "object" ||
		Array.isArray(scripts)
	) {
		return { kind: "unparseable", reason: "scripts is not an object" };
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(scripts)) {
		if (typeof value !== "string") {
			return { kind: "unparseable", reason: `scripts.${key} is not a string` };
		}
		out[key] = value;
	}
	return { kind: "scripts", scripts: out };
}
