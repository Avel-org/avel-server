import { matchesGlob, supportedGlob } from "../../../rooms/globs";
import type { GateFinding } from "../types";
import { byId } from "./shared";

export const PROTECTED_PATHS_SOURCE = "checkpoint:protected-paths";

/** Which gate carries the checkpoint. A checkpoint blocks on any gate, so this only places it. */
export const PROTECTED_PATHS_GATE = "qa";

/**
 * The gate's own configuration, which the commit it judges must not change.
 * Workflows are read from the root only, so they stay rooted. Tool configs are
 * also picked up in workspace packages, so they match at any depth (`**`
 * matches zero segments too). package.json is left out on purpose: a blob
 * comparison would flag every dependency bump. Its scripts are compared one
 * by one through `packageJsonScripts`. Lockfiles and `.husky/` stay out:
 * a dependency bump is not gate config, and hooks do not run in CI.
 * Repo-specific gate scripts belong in per-repo config, not here.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
	".github/workflows/**",
	// Composite actions the workflows call.
	".github/actions/**",
	"**/vitest.config.*",
	"**/vitest.workspace.*",
	"**/stryker.conf.*",
	"**/stryker.config.*",
	"**/playwright.config.*",
	"**/jest.config.*",
	"**/biome.json",
	"**/biome.jsonc",
	"**/eslint.config.*",
	"**/.eslintrc*",
	"**/tsconfig*.json",
];

export type ProtectedPathsInput = {
	/** Globs, from config. */
	protectedPaths: readonly string[];
	/** Path to blob sha at the base commit. */
	base: Readonly<Record<string, string>>;
	/** Path to blob sha at `commitSha`. */
	head: Readonly<Record<string, string>>;
	commitSha: string;
	dispatchId?: string;
	/** package.json `scripts` at base and head. Required when head has a package.json. */
	packageJsonScripts?: {
		base: Readonly<Record<string, string>>;
		head: Readonly<Record<string, string>>;
	};
};

/**
 * A commit may not change what judges it. Every path under a protected glob
 * that was added, removed or changed between base and head is a checkpoint
 * fail, so no override clears it; so is every package.json script that was
 * added, removed or changed. Nothing changed is one pass. No protected paths,
 * a glob the matcher cannot read, or a head package.json whose scripts are
 * not given, is an error: nothing is shown protected.
 *
 * The caller parses package.json at both commits for `packageJsonScripts`.
 * When head's does not parse, the caller adds "package.json" to
 * `protectedPaths` instead, so any change to the file blocks as a blob
 * comparison.
 */
export function protectedPathFindings(
	input: ProtectedPathsInput,
): GateFinding[] {
	const base = {
		gate: PROTECTED_PATHS_GATE,
		kind: "checkpoint",
		source: PROTECTED_PATHS_SOURCE,
		commitSha: input.commitSha,
	} as const;
	const prefix = "checkpoint:protected";
	const by = input.dispatchId ? ` (dispatch ${input.dispatchId})` : "";

	if (input.protectedPaths.length === 0) {
		return [
			{
				...base,
				id: prefix,
				subject: `No protected paths${by}`,
				outcome: "error",
			},
		];
	}
	const unsupported = input.protectedPaths.filter((g) => !supportedGlob(g));
	if (unsupported.length > 0) {
		return [
			{
				...base,
				id: prefix,
				subject: `Unsupported protected globs: ${unsupported.join(", ")}${by}`,
				outcome: "error",
			},
		];
	}

	if (
		Object.hasOwn(input.head, "package.json") &&
		input.packageJsonScripts === undefined
	) {
		return [
			{
				...base,
				id: prefix,
				subject: `package.json is at head but its scripts were not given${by}`,
				outcome: "error",
			},
		];
	}

	const globs = [...new Set(input.protectedPaths)].sort(cmp);
	const findings: GateFinding[] = [];
	for (const { key: path, change } of changes(input.base, input.head)) {
		const matched = globs.filter((g) => matchesGlob(path, g));
		if (matched.length === 0) continue;
		findings.push({
			...base,
			id: `${prefix}:${path}`,
			subject: `${path}: ${change} (protected by ${matched.join(", ")})${by}`,
			outcome: "fail",
		});
	}
	if (input.packageJsonScripts) {
		const { base: before, head: after } = input.packageJsonScripts;
		for (const { key, change } of changes(before, after)) {
			findings.push({
				...base,
				id: `${prefix}:package.json#scripts.${key}`,
				subject: `package.json scripts.${key}: ${change}${by}`,
				outcome: "fail",
			});
		}
	}
	if (findings.length === 0) {
		return [
			{
				...base,
				id: prefix,
				subject: `No protected path changed${by}`,
				outcome: "pass",
			},
		];
	}
	return byId(findings);
}

/** Keys added, removed or changed between two records. The caller sorts. */
function changes(
	before: Readonly<Record<string, string>>,
	after: Readonly<Record<string, string>>,
): Array<{ key: string; change: "added" | "removed" | "changed" }> {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	const out: Array<{ key: string; change: "added" | "removed" | "changed" }> =
		[];
	for (const key of keys) {
		const had = Object.hasOwn(before, key);
		const has = Object.hasOwn(after, key);
		if (had && !has) out.push({ key, change: "removed" });
		else if (!had && has) out.push({ key, change: "added" });
		else if (before[key] !== after[key]) out.push({ key, change: "changed" });
	}
	return out;
}

/** Code-unit order, never locale order (DEV-TIPS §2). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
