import type { Snapshot } from "./snapshot";

/**
 * The languages a repository is written in, read from its tree: file
 * extensions, counted, and the manifest files that declare a toolchain.
 * Code, never a model. The gate needs this before it can judge a project
 * that is not TypeScript (module 9); the list is the stacks AVEL plans
 * adapters for first, and anything else is not counted.
 */

const BY_EXTENSION: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	go: "go",
	rs: "rust",
	ex: "elixir",
	exs: "elixir",
	rb: "ruby",
};

/** A manifest's file name, matched at any depth, and the language it declares. */
const MANIFESTS: ReadonlyArray<[RegExp, string]> = [
	[/^package\.json$/, "javascript"],
	[/^tsconfig(\.[^/]+)?\.json$/, "typescript"],
	[/^pyproject\.toml$/, "python"],
	[/^requirements[^/]*\.txt$/, "python"],
	[/^setup\.py$/, "python"],
	[/^go\.mod$/, "go"],
	[/^Cargo\.toml$/, "rust"],
	[/^mix\.exs$/, "elixir"],
	[/^Gemfile$/, "ruby"],
];

export type LanguageCount = {
	language: string;
	/** Source files with one of the language's extensions. */
	files: number;
	/** The manifest files that declare it, by path, in byte order. */
	manifests: string[];
};

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every language with a source file or a manifest: most files first, then by
 * name in byte order, so the same tree always gives the same list. A
 * declaration file (`.d.ts`) counts as TypeScript; a manifest with no source
 * file still lists its language, with zero files.
 */
export function detectLanguages(snapshot: Snapshot): LanguageCount[] {
	const counts = new Map<string, LanguageCount>();
	const entry = (language: string) => {
		let c = counts.get(language);
		if (!c) {
			c = { language, files: 0, manifests: [] };
			counts.set(language, c);
		}
		return c;
	};
	for (const { path } of snapshot.entries) {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const dot = name.lastIndexOf(".");
		const ext = dot > 0 ? name.slice(dot + 1) : "";
		// Own keys only: a file named x.constructor is not a language.
		const language = Object.hasOwn(BY_EXTENSION, ext)
			? BY_EXTENSION[ext]
			: undefined;
		if (language) entry(language).files += 1;
		for (const [pattern, declared] of MANIFESTS) {
			if (pattern.test(name)) entry(declared).manifests.push(path);
		}
	}
	return [...counts.values()]
		.map((c) => ({ ...c, manifests: [...c.manifests].sort(byteOrder) }))
		.sort((a, b) => b.files - a.files || byteOrder(a.language, b.language));
}
