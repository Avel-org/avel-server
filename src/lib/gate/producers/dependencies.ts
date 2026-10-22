import type { GateFinding } from "../types";
import { SECURITY_GATE } from "./secret-scan";
import { byId, cmp } from "./shared";

export const DEPENDENCIES_SOURCE = "dependencies";

/**
 * Whether a name exists in the registry. Nothing here has the network, so
 * it is not installed: the runner's frozen-lockfile install will feed it.
 * Its own source, not `runner`, so it counts only where the playbook lists
 * the security gate.
 */
export const REGISTRY_SOURCE = "registry";

/** The sections whose entries are installed. */
const DEPENDENCY_SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

/** The sections that redirect what an installed name resolves to. */
const OVERRIDE_SECTIONS = [
	"overrides",
	"resolutions",
	"pnpm.overrides",
] as const;

/** npm's package-name rules: lowercase, URL-safe, at most 214 characters. */
const NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A version, range, tag or union of ranges: what the registry resolves. */
const RANGE = /^[0-9A-Za-z.^~<>=*|+\s-]*$/;

/** npm-package-arg reads a specifier ending in these as a local tarball, not a tag. */
const TARBALL = /\.(?:tgz|tar|tar\.gz)$/i;

/** An npm override's `$name`: the version the root package.json gives that name. */
const REFERENCE =
	/^\$(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Workspace and catalog specifiers resolve inside the repo's own lockfile. */
const LOCAL = /^(?:workspace|catalog):/;

/**
 * Everything the dependency check reads by, the same objects it uses, so
 * GATE_CONFIG carries them and the receipt's config hash changes with them.
 */
export const DEPENDENCY_RULES = Object.freeze({
	sections: [...DEPENDENCY_SECTIONS, ...OVERRIDE_SECTIONS] as readonly string[],
	patterns: Object.freeze({
		name: NAME,
		range: RANGE,
		tarball: TARBALL,
		reference: REFERENCE,
		local: LOCAL,
	}) as Readonly<Record<string, RegExp>>,
});

export type DependencyRules = typeof DEPENDENCY_RULES;

/** A package.json the work added or changed, parsed at both commits. */
export type DependencyManifest = {
	path: string;
	/** Parsed JSON at the base; undefined when the base has no file there. */
	base: unknown;
	/** Parsed JSON at head, or undefined when it does not parse. */
	head: unknown;
};

type Spec = {
	section: string;
	name: string;
	spec: unknown;
	/** From an override section, whose keys are selectors, not names; nested npm keys join with `>`. */
	override: boolean;
};

/**
 * Dependencies the work added or changed, on the security gate. Each one
 * must be a valid npm name with a registry specifier: a version, range or
 * tag, an `npm:` alias to one, or `workspace:`/`catalog:`. A git, URL, file
 * or link specifier fails, because nothing downstream pins what it installs;
 * so does a tarball filename, which npm installs as a local file. An
 * override may also be npm's `$name` reference, and a nested npm override
 * is read entry by entry (`a>b`), so reordering its keys is no change.
 * A `workspace:` or `catalog:` one passes: it resolves inside the repo.
 * Whether any other name exists in the registry needs the network, so each
 * is a not_run from `registry`, which the runner's install will feed.
 * A head package.json that does not parse is an error. Nothing added or
 * changed is one pass.
 */
export function dependencyFindings(
	manifests: readonly DependencyManifest[],
	commitSha: string,
): GateFinding[] {
	const base = { gate: SECURITY_GATE, kind: "check", commitSha } as const;
	const prefix = "check:dependency";
	const findings: GateFinding[] = [];
	const sorted = [...manifests].sort((a, b) => cmp(a.path, b.path));
	for (const m of sorted) {
		if (!isObject(m.head)) {
			findings.push({
				...base,
				source: DEPENDENCIES_SOURCE,
				id: `${prefix}:${m.path}`,
				subject: `${m.path} does not parse as a JSON object, so its dependencies were not read`,
				outcome: "error",
			});
			continue;
		}
		const before = new Map(
			specsOf(isObject(m.base) ? m.base : {}).map((s) => [
				key(s),
				JSON.stringify(s.spec),
			]),
		);
		for (const s of specsOf(m.head)) {
			const k = key(s);
			// JSON.stringify(undefined) is undefined, so `has` keeps an unread section from matching a missing one.
			if (before.has(k) && before.get(k) === JSON.stringify(s.spec)) continue;
			const id = `${prefix}:${m.path}#${s.section}.${s.name}`;
			const where = `${m.path} ${s.section}.${s.name}`;
			const problem = problemOf(s);
			if (problem) {
				findings.push({
					...base,
					source: DEPENDENCIES_SOURCE,
					id,
					subject: `${where}: ${problem}`,
					outcome: typeof s.spec === "string" ? "fail" : "error",
				});
				continue;
			}
			if (LOCAL.test((s.spec as string).trim())) {
				findings.push({
					...base,
					source: DEPENDENCIES_SOURCE,
					id,
					subject: `${where}@${String(s.spec)}: resolves inside the repo`,
					outcome: "pass",
				});
				continue;
			}
			findings.push({
				...base,
				source: REGISTRY_SOURCE,
				id,
				subject: `${where}@${String(s.spec)}: whether it exists in the registry is checked by the runner's install`,
				outcome: "not_run",
			});
		}
	}
	if (findings.length > 0) return byId(findings);
	return [
		{
			...base,
			source: DEPENDENCIES_SOURCE,
			id: prefix,
			subject: `No dependency added or changed in ${manifests.length} package.json files`,
			outcome: "pass",
		},
	];
}

function problemOf(s: Spec): string | null {
	if (typeof s.spec !== "string") {
		// Not read, so not shown safe.
		return s.spec === undefined
			? "is not an object, so it was not read"
			: "is not a string specifier, so it was not read";
	}
	// An override key may carry a selector (`foo@<2`, `a>b`), so only an installed name is checked.
	if (!s.override && !validName(s.name)) {
		return "is not a valid npm package name";
	}
	const spec = s.spec.trim();
	if (LOCAL.test(spec)) return null;
	if (s.override && REFERENCE.test(spec)) return null;
	if (TARBALL.test(spec)) {
		return `${spec} is a tarball filename, which installs a local file nothing pins`;
	}
	if (spec.startsWith("npm:")) {
		const alias = spec.slice("npm:".length);
		const at = alias.lastIndexOf("@");
		const name = at > 0 ? alias.slice(0, at) : alias;
		const range = at > 0 ? alias.slice(at + 1) : "";
		if (!validName(name))
			return `aliases ${name}, which is not a valid npm package name`;
		if (!RANGE.test(range) || TARBALL.test(range))
			return `aliases ${name} at ${range}, which is not a registry range`;
		return null;
	}
	if (RANGE.test(spec)) return null;
	return `${spec} is not a registry specifier (git, URL, file or link specifiers install what nothing pins)`;
}

function validName(name: string): boolean {
	return name.length > 0 && name.length <= 214 && NAME.test(name);
}

function specsOf(pkg: Record<string, unknown>): Spec[] {
	const out: Spec[] = [];
	for (const section of [...DEPENDENCY_SECTIONS, ...OVERRIDE_SECTIONS]) {
		const value =
			section === "pnpm.overrides"
				? isObject(pkg.pnpm)
					? pkg.pnpm.overrides
					: undefined
				: pkg[section];
		if (value === undefined) continue;
		if (!isObject(value)) {
			out.push({ section, name: "*", spec: undefined, override: false });
			continue;
		}
		const override = (OVERRIDE_SECTIONS as readonly string[]).includes(section);
		if (override) {
			flatten(value, "", (name, spec) =>
				out.push({ section, name, spec, override }),
			);
			continue;
		}
		for (const [name, spec] of Object.entries(value)) {
			out.push({ section, name, spec, override });
		}
	}
	return out.sort((a, b) => cmp(key(a), key(b)));
}

/**
 * An npm override object's entries as `a>b` paths. A nested object's own
 * version is its `.` key, so `{ a: { ".": "1", b: "2" } }` is `a` at "1"
 * and `a>b` at "2". An object nested deeper than 8 levels is not read.
 */
function flatten(
	value: Record<string, unknown>,
	at: string,
	add: (name: string, spec: unknown) => void,
	depth = 0,
): void {
	for (const [k, v] of Object.entries(value)) {
		const name = at === "" ? k : k === "." ? at : `${at}>${k}`;
		if (isObject(v) && depth < 8) flatten(v, name, add, depth + 1);
		else add(name, v);
	}
}

const key = (s: Spec) => `${s.section}\0${s.name}`;

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
