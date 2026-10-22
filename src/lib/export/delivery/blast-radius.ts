import { matchesGlob, supportedGlob } from "../../../rooms/globs";
import { byCodepoint } from "../order";
import type {
	BlastRadius,
	BlastRadiusContext,
	BlastRadiusPolicy,
	DeleteEntry,
	DeliveryPackage,
	FileEntry,
	OverwriteEntry,
	RemoteEntry,
	RemoteTree,
	Violation,
	ViolationCode,
} from "./types";

/** Always allowed, whatever the roster declares. */
export const AVEL_DIR_GLOB = ".avel/**";

/** Always protected. `.git` is protected as a segment at any depth, in any case. */
export const BUILT_IN_PROTECTED_GLOBS: readonly string[] = Object.freeze([
	".github/workflows/**",
]);

/** The only modes a package may deliver: a regular file and an executable one. */
export const DELIVERABLE_MODES: readonly string[] = Object.freeze([
	"100644",
	"100755",
]);

const SYMLINK = "120000";
const SUBMODULE = "160000";
const TREE = "040000";

/**
 * The form every path is compared in: POSIX separators, no leading slash,
 * NFC. A path that is not already in this form is a violation.
 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
}

/**
 * The key two paths share when one client filesystem would treat them as one
 * file: case-insensitive and normalization-insensitive. toLowerCase is the
 * Unicode default mapping, not a locale's.
 */
function fold(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

/** A path and each directory above it, shortest first: a/b/c -> a, a/b, a/b/c. */
function prefixes(path: string): string[] {
	const segments = path.split("/");
	return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/**
 * Problems with the path's shape. Any one of them means the path is not
 * compared further: its group and its glob matches would be meaningless.
 */
function shapeViolations(path: string): Violation[] {
	const out: Violation[] = [];
	if (path === "") {
		return [{ code: "PATH_TRAVERSAL", path, detail: "The path is empty" }];
	}
	const normalized = normalizePath(path);
	if (normalized !== path) {
		out.push({
			code: "PATH_NOT_NORMALIZED",
			path,
			detail: `Normalizes to ${JSON.stringify(normalized)}`,
		});
	}
	const posix = path.replace(/\\/g, "/");
	if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
		out.push({ code: "PATH_TRAVERSAL", path, detail: "The path is absolute" });
	}
	const segments = posix.replace(/^\/+/, "").split("/");
	if (segments.includes("..")) {
		out.push({ code: "PATH_TRAVERSAL", path, detail: "The path contains .." });
	}
	if (segments.some((s) => s === "" || s === ".")) {
		out.push({
			code: "PATH_NOT_NORMALIZED",
			path,
			detail: "The path has an empty or . segment",
		});
	}
	return out;
}

/**
 * What delivering `pkg` onto `remote` would do (docs/BLAST-RADIUS.md,
 * Computing the diff), extended with deletes. Pure: no network, database or
 * clock. Every list is in codepoint order, so the result never depends on
 * the order of its inputs.
 *
 * A package path is classified (create, overwrite, unchanged or delete) only
 * when its shape is sound, it appears once, and it does not land on a
 * symlink, submodule or directory. A classified path can still carry a
 * violation, such as being outside the allowed set, so the operator sees what
 * it would have done. Any violation blocks delivery, and none is overridable.
 */
export function computeBlastRadius(
	pkg: DeliveryPackage,
	remote: RemoteTree,
	policy: BlastRadiusPolicy,
	context: BlastRadiusContext,
): BlastRadius {
	if (remote.commitSha === null && remote.entries.size > 0) {
		throw new Error("An empty repository (null commitSha) has no entries");
	}
	const violations: Violation[] = [];
	const add = (code: ViolationCode, path: string, detail: string) =>
		violations.push({ code, path, detail });

	// Policy globs the matcher cannot read. A denylist glob that matches
	// nothing would protect nothing, so it blocks instead.
	for (const glob of policy.protectedPaths) {
		if (!supportedGlob(glob)) {
			add(
				"POLICY_GLOB_UNSUPPORTED",
				glob,
				"A protected-path glob the matcher cannot read",
			);
		}
	}
	const allowedGlobs = [...policy.writablePaths, AVEL_DIR_GLOB];
	const protectedGlobs = [
		...BUILT_IN_PROTECTED_GLOBS,
		...policy.protectedPaths,
	];

	// Every path the package names, with how many times it is named.
	const named = new Map<string, number>();
	for (const p of [...pkg.files.map((f) => f.path), ...pkg.deletes]) {
		named.set(p, (named.get(p) ?? 0) + 1);
	}

	// Remote names: every entry and every directory above one.
	const remoteDirs = new Set<string>();
	const remoteNamesByFold = new Map<string, Set<string>>();
	for (const [path, entry] of remote.entries) {
		const all = prefixes(path);
		for (const name of all) {
			const key = fold(name);
			const set = remoteNamesByFold.get(key) ?? new Set<string>();
			set.add(name);
			remoteNamesByFold.set(key, set);
		}
		for (const dir of all.slice(0, -1)) remoteDirs.add(dir);
		if (entry.mode === TREE) remoteDirs.add(path);
	}

	const wellFormed = new Set<string>();
	for (const p of named.keys()) {
		const shape = shapeViolations(p);
		violations.push(...shape);
		if (shape.length === 0) wellFormed.add(p);
	}

	// Package names: every well-formed path and every directory above one.
	const packageNamesByFold = new Map<string, Set<string>>();
	const packageDirs = new Set<string>();
	for (const p of pkg.files.map((f) => f.path)) {
		if (!wellFormed.has(p)) continue;
		for (const dir of prefixes(p).slice(0, -1)) packageDirs.add(dir);
	}
	for (const p of wellFormed) {
		for (const name of prefixes(p)) {
			const key = fold(name);
			const set = packageNamesByFold.get(key) ?? new Set<string>();
			set.add(name);
			packageNamesByFold.set(key, set);
		}
	}

	// Paths that land under a remote symlink, submodule or file: never classified.
	const underSpecial = new Set<string>();

	// Rules that hold for every well-formed path, written or deleted.
	for (const p of wellFormed) {
		const count = named.get(p) ?? 0;
		if (count > 1) {
			add("DUPLICATE_PATH", p, `The package names this path ${count} times`);
		}
		if (!allowedGlobs.some((g) => matchesGlob(p, g))) {
			add(
				"PATH_OUTSIDE_ALLOWED",
				p,
				"Outside the roster's writable paths and .avel/",
			);
		}
		if (p.split("/").some((s) => fold(s) === ".git")) {
			add("PROTECTED_PATH", p, "Inside a .git directory");
		}
		const hit = protectedGlobs.filter((g) => matchesGlob(p, g));
		if (hit.length > 0) {
			add(
				"PROTECTED_PATH",
				p,
				`Protected by ${[...new Set(hit)].sort(byCodepoint).join(", ")}`,
			);
		}
		for (const name of prefixes(p)) {
			const key = fold(name);
			for (const other of remoteNamesByFold.get(key) ?? []) {
				if (other !== name) {
					add(
						"CASE_COLLISION",
						p,
						`${name} and the repository's ${other} are one name on a case-insensitive filesystem`,
					);
				}
			}
			for (const other of packageNamesByFold.get(key) ?? []) {
				if (other !== name) {
					add(
						"CASE_COLLISION",
						p,
						`${name} and the package's ${other} are one name on a case-insensitive filesystem`,
					);
				}
			}
		}
		// A remote symlink, submodule or file above this path.
		for (const dir of prefixes(p).slice(0, -1)) {
			const above = remote.entries.get(dir);
			if (above === undefined) continue;
			if (above.mode !== TREE) underSpecial.add(p);
			if (above.mode === SYMLINK || above.mode === SUBMODULE) {
				add(
					"SPECIAL_FILE_COLLISION",
					p,
					`${dir} is a ${kindOf(above)} in the repository`,
				);
			} else if (above.mode !== TREE) {
				add("PATH_TYPE_COLLISION", p, `${dir} is a file in the repository`);
			}
		}
	}

	const create: FileEntry[] = [];
	const overwrite: OverwriteEntry[] = [];
	const unchanged: FileEntry[] = [];
	const deleted: DeleteEntry[] = [];

	for (const file of pkg.files) {
		const p = file.path;
		if (!wellFormed.has(p)) continue;
		let blocked = (named.get(p) ?? 0) > 1 || underSpecial.has(p);
		if (!DELIVERABLE_MODES.includes(file.mode)) {
			add(
				"UNSUPPORTED_MODE",
				p,
				`Mode ${file.mode} is not ${DELIVERABLE_MODES.join(" or ")}`,
			);
			blocked = true;
		}
		if (packageDirs.has(p)) {
			add("PATH_TYPE_COLLISION", p, "The package also writes files under it");
			blocked = true;
		}
		const there = remote.entries.get(p);
		if (there && (there.mode === SYMLINK || there.mode === SUBMODULE)) {
			add(
				"SPECIAL_FILE_COLLISION",
				p,
				`The target is a ${kindOf(there)} in the repository`,
			);
			blocked = true;
		} else if (remoteDirs.has(p)) {
			add(
				"PATH_TYPE_COLLISION",
				p,
				"The target is a directory in the repository",
			);
			blocked = true;
		}
		if (blocked) continue;
		const entry: FileEntry = {
			path: p,
			mode: file.mode,
			bytes: file.bytes,
			blobSha: file.blobSha,
		};
		if (there === undefined) create.push(entry);
		else if (there.sha === file.blobSha && there.mode === file.mode)
			unchanged.push(entry);
		else
			overwrite.push({
				...entry,
				remoteBlobSha: there.sha,
				remoteMode: there.mode,
			});
	}

	for (const p of pkg.deletes) {
		if (!wellFormed.has(p) || (named.get(p) ?? 0) > 1 || underSpecial.has(p))
			continue;
		const there = remote.entries.get(p);
		if (there && (there.mode === SYMLINK || there.mode === SUBMODULE)) {
			add(
				"SPECIAL_FILE_COLLISION",
				p,
				`The delete targets a ${kindOf(there)} in the repository`,
			);
		} else if (
			there === undefined ||
			there.mode === TREE ||
			remoteDirs.has(p)
		) {
			add(
				"DELETE_NOT_FOUND",
				p,
				remoteDirs.has(p)
					? "The delete targets a directory, not a file"
					: "The repository has no file at this path",
			);
		} else {
			deleted.push({
				path: p,
				remoteBlobSha: there.sha,
				remoteMode: there.mode,
			});
		}
	}

	// PRESERVE: remote files the package does not name. Counted, never listed.
	let fileCount = 0;
	const topLevel = new Set<string>();
	for (const [path, entry] of remote.entries) {
		if (entry.mode === TREE || named.has(path)) continue;
		fileCount++;
		const slash = path.indexOf("/");
		topLevel.add(slash === -1 ? path : `${path.slice(0, slash)}/`);
	}

	const byPath = <T extends { path: string }>(xs: T[]) =>
		xs.sort((a, b) => byCodepoint(a.path, b.path));
	const unique = dedupe(violations).sort(
		(a, b) =>
			byCodepoint(a.path, b.path) ||
			byCodepoint(a.code, b.code) ||
			byCodepoint(a.detail, b.detail),
	);

	return {
		computedAt: context.computedAt,
		baseRef: context.baseRef,
		baseCommitSha: remote.commitSha,
		target: { ...context.target },
		create: byPath(create),
		overwrite: byPath(overwrite),
		unchanged: byPath(unchanged),
		delete: byPath(deleted),
		preserveSummary: {
			fileCount,
			topLevelDirs: [...topLevel].sort(byCodepoint),
		},
		violations: unique,
		totals: {
			create: create.length,
			overwrite: overwrite.length,
			unchanged: unchanged.length,
			delete: deleted.length,
			violations: unique.length,
		},
	};
}

function kindOf(entry: RemoteEntry): string {
	return entry.mode === SYMLINK ? "symlink" : "submodule";
}

function dedupe(violations: Violation[]): Violation[] {
	const seen = new Map<string, Violation>();
	for (const v of violations) {
		seen.set(JSON.stringify([v.code, v.path, v.detail]), v);
	}
	return [...seen.values()];
}
