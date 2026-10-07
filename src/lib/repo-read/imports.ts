import type { Snapshot } from "./snapshot";

/** import ... from "x", export ... from "x", import("x"), require("x"), import "x". */
const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

const SOURCE = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];

function normalize(parts: string[]): string | null {
	const out: string[] = [];
	for (const p of parts) {
		if (p === "" || p === ".") continue;
		if (p === "..") {
			if (out.length === 0) return null;
			out.pop();
		} else out.push(p);
	}
	return out.join("/");
}

/**
 * The repository's relative import graph: for each source file with text,
 * the files it imports that exist in the snapshot. Bare specifiers (packages)
 * and anything that does not resolve to a file are dropped. Resolution tries
 * the path as written, with each source extension, a TypeScript file for a
 * .js specifier, and an index file. Sorted, so the result does not depend
 * on match order.
 */
export function importGraph(snapshot: Snapshot): Map<string, string[]> {
	const files = new Set(snapshot.entries.map((e) => e.path));
	const resolve = (from: string, spec: string): string | null => {
		const dir = from.split("/").slice(0, -1);
		const base = normalize([...dir, ...spec.split("/")]);
		if (base === null) return null;
		const candidates = [
			base,
			...EXTENSIONS.map((x) => base + x),
			...(/\.[cm]?js$/.test(base)
				? [base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx")]
				: []),
			...EXTENSIONS.map((x) => `${base}/index${x}`),
		];
		return candidates.find((c) => files.has(c)) ?? null;
	};
	const graph = new Map<string, string[]>();
	for (const e of snapshot.entries) {
		if (e.text === undefined || !SOURCE.test(e.path)) continue;
		const targets = new Set<string>();
		for (const m of e.text.matchAll(SPECIFIER)) {
			const spec = m[1];
			if (!spec || !(spec.startsWith("./") || spec.startsWith("../"))) continue;
			const target = resolve(e.path, spec);
			if (target && target !== e.path) targets.add(target);
		}
		if (targets.size > 0) graph.set(e.path, [...targets].sort());
	}
	return graph;
}
