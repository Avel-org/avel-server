import type { Boundary } from "../../contract/repo-read";
import type { CutResult } from "./cut";
import { importGraph } from "./imports";
import type { Snapshot } from "./snapshot";

/**
 * A file every feature must register itself in: a NestJS app.module, a
 * router table, a barrel index. It belongs to no feature (ROSTER-V2, "Name
 * the composition root explicitly").
 */
const COMPOSITION_ROOT =
	/(^|\/)(app\.module|routes|router|index)\.[cm]?[jt]sx?$/;

/** Bytes per line, for files whose text was not kept. */
const BYTES_PER_LINE = 40;

const inside = (path: string, dir: string) => path.startsWith(`${dir}/`);

/** Lines in a text: a final newline ends the last line rather than starting one. */
const lines = (text: string) =>
	text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * The natural split, one Boundary per directory the cut rests on. A file
 * outside every boundary collides when two or more boundaries touch it:
 * they import it, or it is a composition root that imports them.
 */
export function deriveBoundaries(
	snapshot: Snapshot,
	cut: CutResult,
): Boundary[] {
	if (cut.cut === null) return [];
	const graph = importGraph(snapshot);
	const owner = (path: string) => cut.boundaries.find((b) => inside(path, b));

	const touchers = new Map<string, Set<string>>();
	const touch = (file: string, boundary: string) => {
		let set = touchers.get(file);
		if (!set) {
			set = new Set();
			touchers.set(file, set);
		}
		set.add(boundary);
	};
	for (const [from, targets] of graph) {
		const fromBoundary = owner(from);
		for (const to of targets) {
			const toBoundary = owner(to);
			if (fromBoundary && !toBoundary) touch(to, fromBoundary);
			if (!fromBoundary && toBoundary && COMPOSITION_ROOT.test(from)) {
				touch(from, toBoundary);
			}
		}
	}
	const collisions = new Map<string, string[]>();
	for (const [file, set] of touchers) {
		if (set.size < 2) continue;
		for (const b of set)
			collisions.set(b, [...(collisions.get(b) ?? []), file]);
	}

	return cut.boundaries.map((path) => {
		let files = 0;
		let loc = 0;
		for (const e of snapshot.entries) {
			if (!inside(e.path, path)) continue;
			files += 1;
			loc +=
				e.text !== undefined
					? lines(e.text)
					: Math.ceil(e.size / BYTES_PER_LINE);
		}
		return {
			kind: cut.cut === "vertical" ? ("feature" as const) : ("layer" as const),
			path,
			files,
			loc,
			suggestedTerritory: path.split("/").at(-1) ?? path,
			collidesWith: (collisions.get(path) ?? []).sort(),
		};
	});
}
