import type { Snapshot } from "./snapshot";

/** Directory names that hold one layer across every feature. */
export const LAYER_DIRECTORIES = [
	"controllers",
	"services",
	"repositories",
	"handlers",
	"models",
	"routes",
	"db",
	"components",
	"views",
	"middleware",
	"entities",
	"resolvers",
	"dto",
] as const;

/** Directory names that hold one directory per feature. */
export const FEATURE_CONTAINERS = ["modules", "features", "domains"] as const;

/** A layer named by file suffix: users.controller.ts is the controller layer. */
const LAYER_SUFFIX =
	/\.(controller|service|repository|dto|entity|handler|model|resolver|guard|middleware)\.[cm]?[jt]sx?$/;

/** Source roots, in the order they are tried. The repository root is the fallback. */
const SOURCE_ROOTS = ["src", "app", "lib"] as const;

export type CutResult = {
	cut: "horizontal" | "vertical" | null;
	/** The commit, the listing, and the rule that decided. Shown with the verdict. */
	evidence: string;
	/** The directory read, "" for the repository root. */
	root: string;
	/** The boundary directories the verdict rests on, full paths. Empty when cut is null. */
	boundaries: string[];
};

const join = (root: string, name: string) => (root ? `${root}/${name}` : name);

/** The immediate child directories of `dir`, sorted. */
export function childDirectories(snapshot: Snapshot, dir: string): string[] {
	const prefix = dir ? `${dir}/` : "";
	const names = new Set<string>();
	for (const { path } of snapshot.entries) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash > 0) names.add(rest.slice(0, slash));
	}
	return [...names].sort();
}

/** The layer kinds inside a feature directory: by suffix, or by layer subdirectory. */
function layerKinds(snapshot: Snapshot, dir: string): Set<string> {
	const kinds = new Set<string>();
	const prefix = `${dir}/`;
	for (const { path } of snapshot.entries) {
		if (!path.startsWith(prefix)) continue;
		const suffix = LAYER_SUFFIX.exec(path);
		if (suffix?.[1]) kinds.add(suffix[1]);
		const first = path.slice(prefix.length).split("/");
		if (
			first.length > 1 &&
			(LAYER_DIRECTORIES as readonly string[]).includes(first[0] ?? "")
		) {
			kinds.add(first[0] ?? "");
		}
	}
	return kinds;
}

/**
 * The monorepo case: several packages each with their own source root. The
 * cut is per package there, and a scalar cut cannot say so, so the read
 * answers null (DATA-CONTRACTS-V2, Mission: the open scalar-cut question).
 */
function packageRoots(snapshot: Snapshot): string[] {
	return childDirectories(snapshot, "packages").filter((p) =>
		snapshot.entries.some((e) => e.path.startsWith(`packages/${p}/src/`)),
	);
}

function sourceRoot(snapshot: Snapshot): string {
	const top = childDirectories(snapshot, "");
	return SOURCE_ROOTS.find((r) => top.includes(r)) ?? "";
}

const list = (names: string[]) => names.map((n) => `${n}/`).join(", ");

/**
 * Which boundary is a directory (ROSTER-V2): the cut, read from the tree.
 *
 * - vertical: a feature container (modules/, features/, domains/) under the
 *   source root holds two or more features that each hold two or more layers.
 * - horizontal: the source root holds two or more layer directories, and no
 *   feature container qualifies.
 * - null: both, neither, or a monorepo. Null blocks approval; it is never guessed.
 */
export function deriveCut(snapshot: Snapshot): CutResult {
	const at = `commit ${snapshot.commitSha}`;
	const packages = packageRoots(snapshot);
	if (packages.length > 1) {
		return {
			cut: null,
			root: "packages",
			boundaries: [],
			evidence: `${at}: packages/ holds ${packages.length} packages with their own src/ (${list(packages)}). The cut is per package, and one cut cannot describe them, so none is derived.`,
		};
	}
	const root =
		packages.length === 1
			? `packages/${packages[0]}/src`
			: sourceRoot(snapshot);
	const shown = root ? `${root}/` : "the repository root";
	const children = childDirectories(snapshot, root);

	const features: string[] = [];
	let container: string | undefined;
	for (const name of FEATURE_CONTAINERS) {
		if (!children.includes(name)) continue;
		const dir = join(root, name);
		const qualifying = childDirectories(snapshot, dir).filter(
			(f) => layerKinds(snapshot, join(dir, f)).size >= 2,
		);
		if (qualifying.length >= 2) {
			container = dir;
			features.push(...qualifying.map((f) => join(dir, f)));
			break;
		}
	}
	const layers = children.filter((c) =>
		(LAYER_DIRECTORIES as readonly string[]).includes(c),
	);
	const vertical = container !== undefined;
	const horizontal = layers.length >= 2;

	if (vertical && !horizontal) {
		const names = features.map((f) => f.slice((container?.length ?? 0) + 1));
		return {
			cut: "vertical",
			root,
			boundaries: features,
			evidence: `${at}: feature-organised. ${container}/ holds ${names.length} features (${list(names)}), each with two or more layers, so one agent per feature.`,
		};
	}
	if (horizontal && !vertical) {
		return {
			cut: "horizontal",
			root,
			boundaries: layers.map((l) => join(root, l)),
			evidence: `${at}: layer-organised. ${shown} holds layer directories (${list(layers)}), so one agent per layer.`,
		};
	}
	if (vertical && horizontal) {
		return {
			cut: null,
			root,
			boundaries: [],
			evidence: `${at}: both. ${container}/ holds features with their own layers, and ${shown} also holds layer directories (${list(layers)}). Neither boundary is the directory, so no cut is derived.`,
		};
	}
	return {
		cut: null,
		root,
		boundaries: [],
		evidence: `${at}: neither. ${shown} holds ${children.length ? list(children) : "no directories"}: no feature container with two or more layered features, and fewer than two layer directories, so no cut is derived.`,
	};
}
