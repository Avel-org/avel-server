/**
 * Writable-glob matching for rooms (module 7). Pure. Compared by path
 * segment, never by character, like classifyGlob in
 * src/contract/shared/coherence.ts: `src/db/**` never matches `src/dbx/a`.
 *
 * Supported: `**` as a whole segment (zero or more segments), `*` and `?`
 * inside a segment (never crossing `/`), literals, a leading `./`, and a
 * trailing `/` meaning everything under that directory. Dot files match
 * like any other name. Anything else (braces, classes, `!` negation)
 * matches nothing, so an unsupported glob fails closed: it grants no write.
 */

const UNSUPPORTED = /[[\]{}()!\\]/;

function segmentPattern(segment: string): RegExp {
	// One segment holds no /, so * and ? can never cross one.
	const body = segment
		.split("")
		.map((c) =>
			c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^$|]/g, "\\$&"),
		)
		.join("");
	return new RegExp(`^${body}$`);
}

function globSegments(glob: string): string[] | null {
	let g = glob.trim();
	if (g === "" || UNSUPPORTED.test(g) || g.startsWith("/")) return null;
	while (g.startsWith("./")) g = g.slice(2);
	if (g.endsWith("/")) g = `${g}**`;
	const segments = g.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
	return segments;
}

function matchFrom(
	path: string[],
	i: number,
	glob: string[],
	j: number,
): boolean {
	if (j === glob.length) return i === path.length;
	const g = glob[j] as string;
	if (g === "**") {
		for (let k = i; k <= path.length; k++) {
			if (matchFrom(path, k, glob, j + 1)) return true;
		}
		return false;
	}
	if (i === path.length) return false;
	return (
		segmentPattern(g).test(path[i] as string) &&
		matchFrom(path, i + 1, glob, j + 1)
	);
}

/**
 * Whether matchesGlob understands a glob. It matches nothing for any other,
 * which grants no write here but would let a gate checkpoint miss every path.
 */
export function supportedGlob(glob: string): boolean {
	return globSegments(glob) !== null;
}

/** Whether a normalized room path (a/b/c.ts) matches one writable glob. */
export function matchesGlob(path: string, glob: string): boolean {
	const segments = globSegments(glob);
	if (!segments) return false;
	return matchFrom(path.split("/"), 0, segments, 0);
}

/** Whether a normalized room path matches any of the writable globs. */
export function writable(path: string, globs: readonly string[]): boolean {
	return globs.some((g) => matchesGlob(path, g));
}
