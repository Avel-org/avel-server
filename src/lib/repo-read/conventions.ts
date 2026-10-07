import type { ConventionSet } from "../../contract/repo-read";
import type { CutResult } from "./cut";
import type { Snapshot, SnapshotEntry } from "./snapshot";

/** A pattern is the convention only when it holds at least this share of its samples. */
export const DOMINANCE = 0.8;

/** Evidence lists at most this many sample files per entry, in path order. */
export const EVIDENCE_SAMPLE = 10;

type Majority<V extends string> = {
	value: V | null;
	disagreement: string | null;
};

/**
 * The dominant value of a count, or a disagreement saying exactly what the
 * tree held: "naming: 5 .spec (62%), 3 .test (38%)". Ties and order are
 * broken by count, then value, in byte order.
 */
export function majority<V extends string>(
	label: string,
	counts: Map<V, number>,
): Majority<V> {
	const sorted = [...counts.entries()].sort((a, b) =>
		b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
	);
	const total = sorted.reduce((n, [, c]) => n + c, 0);
	const top = sorted[0];
	if (!top || total === 0) return { value: null, disagreement: null };
	if (top[1] / total >= DOMINANCE) return { value: top[0], disagreement: null };
	const parts = sorted.map(
		([v, c]) => `${c} ${v} (${Math.round((100 * c) / total)}%)`,
	);
	return { value: null, disagreement: `${label}: ${parts.join(", ")}` };
}

function count<V extends string>(values: V[]): Map<V, number> {
	const counts = new Map<V, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return counts;
}

const sample = (paths: string[]) => paths.slice(0, EVIDENCE_SAMPLE);
const base = (path: string) => path.split("/").at(-1) ?? path;

const SOURCE = /\.[cm]?[jt]sx?$/;
const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const OTHER_TEST = /(_test\.go|(^|\/)test_[^/]*\.py|_test\.py)$/;
const SEPARATE_TEST_DIR = /(^|\/)(tests?|__tests__|spec|e2e)\//;
const JS_RUNNERS = ["vitest", "jest", "mocha", "ava"] as const;

const ESLINT =
	/(^|\/)(\.eslintrc(\.(json|js|cjs|ya?ml))?|eslint\.config\.[cm]?[jt]s)$/;
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;
const PRECOMMIT =
	/^(\.husky\/pre-commit|\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml)$/;
const CI =
	/^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml)$/;
const IMPORT_RULES = [
	"no-restricted-imports",
	"import/no-restricted-paths",
	"boundaries/element-types",
	"boundaries/entry-point",
] as const;

/** Parsed package.json dependencies, or none when it does not parse. */
function dependencies(e: SnapshotEntry): string[] {
	try {
		const json = JSON.parse(e.text ?? "") as Record<string, unknown>;
		const keys = (field: string) =>
			Object.keys((json[field] as Record<string, unknown> | undefined) ?? {});
		return [...keys("dependencies"), ...keys("devDependencies")];
	} catch {
		return [];
	}
}

function entryOf(disagreements: (string | null)[], evidence: string[]) {
	const found = disagreements.filter((d): d is string => d !== null);
	return {
		evidence,
		confidence: found.length > 0 ? ("low" as const) : ("high" as const),
		disagreements: found,
	};
}

function testing(snapshot: Snapshot): ConventionSet["testing"] {
	const manifests = snapshot.entries.filter(
		(e) => base(e.path) === "package.json" && e.text !== undefined,
	);
	const runnerOf: Array<{ runner: string; path: string }> = [];
	for (const m of manifests) {
		const deps = dependencies(m);
		for (const r of JS_RUNNERS)
			if (deps.includes(r)) runnerOf.push({ runner: r, path: m.path });
	}
	for (const e of snapshot.entries) {
		if (
			/(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/.test(e.path) &&
			/\bpytest\b/.test(e.text ?? "")
		) {
			runnerOf.push({ runner: "pytest", path: e.path });
		}
	}
	const goTests = snapshot.entries.filter((e) => e.path.endsWith("_test.go"));
	if (goTests[0]) runnerOf.push({ runner: "go test", path: goTests[0].path });

	const tests = snapshot.entries
		.map((e) => e.path)
		.filter((p) => JS_TEST.test(p) || OTHER_TEST.test(p));
	if (runnerOf.length === 0 && tests.length === 0) return undefined;

	const runner = majority("runner", count(runnerOf.map((r) => r.runner)));
	const naming = majority(
		"naming",
		count(
			tests
				.map((p) => JS_TEST.exec(p)?.[1])
				.filter((v): v is string => v !== undefined)
				.map((v) => `.${v}`),
		),
	);
	const location = majority(
		"location",
		count(
			tests.map((p) =>
				SEPARATE_TEST_DIR.test(p)
					? ("separate" as const)
					: ("colocated" as const),
			),
		),
	);
	return {
		runner: runner.value,
		location: location.value,
		naming: naming.value,
		...entryOf(
			[runner.disagreement, naming.disagreement, location.disagreement],
			[...new Set(runnerOf.map((r) => r.path))].sort().concat(sample(tests)),
		),
	};
}

type FileCase = "kebab" | "camel" | "pascal" | "snake";

/** A file name's case, from its stem (the name before the first dot). One lowercase word has no case. */
export function fileCase(path: string): FileCase | null {
	const stem = base(path).split(".")[0] ?? "";
	if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(stem)) return "kebab";
	if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(stem)) return "snake";
	if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(stem)) return "camel";
	if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) return "pascal";
	return null;
}

function naming(snapshot: Snapshot): ConventionSet["naming"] {
	const sources = snapshot.entries.filter(
		(e) =>
			SOURCE.test(e.path) &&
			!JS_TEST.test(e.path) &&
			!base(e.path).includes(".config."),
	);
	const cased = sources
		.map((e) => ({ path: e.path, c: fileCase(e.path) }))
		.filter((x): x is { path: string; c: FileCase } => x.c !== null);
	const exporting = sources.filter(
		(e) => e.text !== undefined && /\bexport\b/.test(e.text),
	);
	if (cased.length === 0 && exporting.length === 0) return undefined;
	const files = majority("files", count(cased.map((x) => x.c)));
	const exports = majority(
		"exports",
		count(
			exporting.map((e) =>
				/\bexport\s+default\b/.test(e.text ?? "")
					? ("default" as const)
					: ("named" as const),
			),
		),
	);
	return {
		files: files.value,
		exports: exports.value,
		...entryOf(
			[files.disagreement, exports.disagreement],
			sample(cased.map((x) => x.path)),
		),
	};
}

function layering(cut: CutResult): ConventionSet["layering"] {
	if (cut.cut === null) return undefined;
	const parent = cut.boundaries[0]?.split("/").slice(0, -1).join("/") ?? "";
	const where = parent ? `${parent}/` : "the repository root";
	return {
		pattern:
			cut.cut === "vertical"
				? `one directory per feature under ${where}, each holding its own layers`
				: `one directory per layer under ${where}`,
		...entryOf([], cut.boundaries),
	};
}

function imports(snapshot: Snapshot): ConventionSet["imports"] {
	const configs = snapshot.entries.filter((e) => ESLINT.test(e.path));
	const rules = new Set<string>();
	const evidence: string[] = [];
	for (const c of configs) {
		const found = IMPORT_RULES.filter((r) => (c.text ?? "").includes(r));
		if (found.length > 0) evidence.push(c.path);
		for (const r of found) rules.add(r);
	}
	if (rules.size === 0) return undefined;
	return { rules: [...rules].sort(), ...entryOf([], evidence) };
}

function formatting(snapshot: Snapshot): ConventionSet["formatting"] {
	const paths = snapshot.entries.map((e) => e.path);
	const tools: Array<{ tool: string; path: string }> = [];
	for (const p of paths) {
		if (/^biome\.jsonc?$/.test(p)) tools.push({ tool: "biome", path: p });
		if (/^(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s)$/.test(p)) {
			tools.push({ tool: "prettier", path: p });
		}
	}
	if (tools.length === 0 && paths.includes(".editorconfig")) {
		tools.push({ tool: "editorconfig", path: ".editorconfig" });
	}
	const first = tools[0];
	if (!first) return undefined;
	const distinct = [...new Set(tools.map((t) => t.tool))];
	const disagreement =
		distinct.length > 1
			? `tools: ${tools.map((t) => `${t.tool} (${t.path})`).join(", ")}`
			: null;
	return {
		tool: distinct.join(", "),
		configPath: first.path,
		...entryOf(
			[disagreement],
			tools.map((t) => t.path),
		),
	};
}

/**
 * The conventions the tree actually follows (DATA-CONTRACTS-V2,
 * ConventionSet). Each entry comes from files or config in the snapshot and
 * names them. An entry the tree gives no evidence for is left out and listed
 * in `unextracted`. A pattern below DOMINANCE is low, with the counts that
 * disagreed, and any low entry makes the set low.
 */
export function extractConventions(
	snapshot: Snapshot,
	cut: CutResult,
): ConventionSet {
	const paths = snapshot.entries.map((e) => e.path);
	const entries = {
		layering: layering(cut),
		testing: testing(snapshot),
		naming: naming(snapshot),
		imports: imports(snapshot),
		formatting: formatting(snapshot),
	};
	const set: ConventionSet = {
		enforcement: {
			eslint: paths.filter((p) => ESLINT.test(p)),
			tsconfig: paths.filter((p) => TSCONFIG.test(p)),
			precommit: paths.filter((p) => PRECOMMIT.test(p)),
			ci: paths.filter((p) => CI.test(p)),
		},
		confidence: Object.values(entries).some((e) => e?.confidence === "low")
			? "low"
			: "high",
		unextracted: Object.entries(entries)
			.filter(([, e]) => e === undefined)
			.map(([name]) => name),
	};
	for (const [name, e] of Object.entries(entries)) {
		if (e !== undefined) Object.assign(set, { [name]: e });
	}
	return set;
}

/** The low entries of a set, as check issues: what disagreed, in entry order. */
export function lowConfidenceIssues(set: ConventionSet) {
	const issues: Array<{ path: Array<string | number>; message: string }> = [];
	for (const name of [
		"layering",
		"testing",
		"naming",
		"imports",
		"formatting",
	] as const) {
		const e = set[name];
		if (!e || e.confidence !== "low") continue;
		for (const d of e.disagreements) {
			issues.push({
				path: ["derivedConventions", name],
				message: `${name}: ${d}`,
			});
		}
	}
	return issues;
}
