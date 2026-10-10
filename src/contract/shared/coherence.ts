import { z } from "zod";
import {
	agentKind,
	type Role,
	role,
	WAVES,
	type Wave,
	wave,
} from "../agent-template";
import { missionCut } from "../mission";
import type { Playbook } from "../playbook";

/**
 * Coherence (DATA-CONTRACTS-V2, Coherence). Pure: no database, no IO, no
 * clock. The loadout renders it live and the export gate runs the same code,
 * so a client that lies about coherence still cannot ship.
 */

/** The Verify family (docs/ROLES.md): writes tests, never source. */
export const VERIFICATION_ROLES = [
	"backend-tests",
	"frontend-tests",
	"property-tests",
	"accessibility",
	"performance",
] as const satisfies readonly Role[];

/**
 * One roster entry as coherence reads it. writablePaths is the resolved set
 * (resolveWritablePaths), never the entry's null meaning "the template's".
 */
export const coherenceEntry = z.object({
	id: z.string().uuid(),
	active: z.boolean(),
	waves: z.array(wave),
	kind: agentKind,
	roles: z.array(role),
	writablePaths: z.array(z.string()),
});

export type CoherenceEntry = z.infer<typeof coherenceEntry>;

export const coherenceInput = z.object({
	cut: missionCut,
	roster: z.array(coherenceEntry),
});

export type CoherenceInput = z.infer<typeof coherenceInput>;

export type CoherencePlaybook = Pick<Playbook, "wavesApplicable" | "gates">;

/** The one hard block. wave is null when the playbook declares no waves. */
export const coherenceBlock = z.object({
	code: z.literal("no_agents_in_first_wave"),
	reason: z.string(),
	wave: wave.nullable(),
});

export type CoherenceBlock = z.infer<typeof coherenceBlock>;

export const verticalCutRole = z.enum(["foundations", "verification"]);

export const coherenceWarning = z.discriminatedUnion("code", [
	z.object({
		code: z.literal("vertical_cut_roles_unassigned"),
		reason: z.string(),
		/** Always in the order foundations, verification. */
		missing: z.array(verticalCutRole).min(1),
	}),
]);

export type CoherenceWarning = z.infer<typeof coherenceWarning>;

export const coherenceResult = z.object({
	block: coherenceBlock.optional(),
	warnings: z.array(coherenceWarning),
});

export type CoherenceResult = z.infer<typeof coherenceResult>;

/** An entry's override wins; null keeps the template's paths. */
export function resolveWritablePaths(
	entry: { writablePaths: string[] | null },
	template: { writablePaths: string[] },
): string[] {
	return entry.writablePaths ?? template.writablePaths;
}

/**
 * The earliest wave the playbook declares, in WAVES order (A to E), whatever
 * order wavesApplicable lists them in. Null when it declares none.
 */
export function earliestWave(
	playbook: Pick<Playbook, "wavesApplicable">,
): Wave | null {
	return WAVES.find((w) => playbook.wavesApplicable.includes(w)) ?? null;
}

export function computeCoherence(
	input: CoherenceInput,
	playbook: CoherencePlaybook,
): CoherenceResult {
	const active = input.roster.filter((e) => e.active);
	const warnings: CoherenceWarning[] = [];

	// Decided (J, 2026-10-10): this applies under any vertical cut, whatever
	// gates the playbook declares. Gate-relative warnings come later.
	if (input.cut === "vertical") {
		const holds = (r: (e: CoherenceEntry) => boolean) => active.some(r);
		const missing: Array<z.infer<typeof verticalCutRole>> = [];
		if (!holds((e) => e.roles.includes("foundations")))
			missing.push("foundations");
		if (
			!holds((e) =>
				e.roles.some((r) =>
					(VERIFICATION_ROLES as readonly Role[]).includes(r),
				),
			)
		)
			missing.push("verification");
		if (missing.length > 0)
			warnings.push({
				code: "vertical_cut_roles_unassigned",
				reason: `A vertical cut needs ${missing.join(" and ")} assigned to an active agent`,
				missing,
			});
	}

	const block = firstWaveBlock(active, playbook);
	return block ? { block, warnings } : { warnings };
}

/** Fails closed: a playbook with no waves can never be staffed, so it blocks. */
function firstWaveBlock(
	active: CoherenceEntry[],
	playbook: CoherencePlaybook,
): CoherenceBlock | undefined {
	const first = earliestWave(playbook);
	if (first === null)
		return {
			code: "no_agents_in_first_wave",
			reason: "The playbook declares no waves, so no agent can staff its first",
			wave: null,
		};
	if (active.some((e) => e.waves.includes(first))) return undefined;
	return {
		code: "no_agents_in_first_wave",
		reason: `No active agent is in wave ${first}, the earliest the playbook declares`,
		wave: first,
	};
}

/*
 * Glob disjointness. Standalone and wired into no warning yet: the
 * disjointness half of the vertical-cut rule waits until writable_paths has
 * an exclusion form (J, 2026-10-10). When it lands, a human's foundations
 * entry is exempt.
 *
 * Every comparison is by path segment, never by character, so src/db/** and
 * src/dbx/** are disjoint. A literal without a trailing slash is read as a
 * file; write a directory as dir/ or dir/**.
 */

export type GlobClass =
	/** ** or **\/*: every path. */
	| { kind: "all" }
	/** Literal segments ending in / or /**: everything under a directory. */
	| { kind: "prefix"; segments: string[] }
	/** No wildcard: one file. */
	| { kind: "file"; segments: string[] }
	/** **\/<leaf>, the leaf using only literal characters and *. */
	| { kind: "leaf"; leaf: string }
	/** Anything else: a mid-path wildcard, ?, braces, classes, ! negation. */
	| { kind: "unknown" };

export type Overlap = "disjoint" | "overlap" | "unknown";

const WILDCARD = /[*?[\]{}()!]/;
const OTHER_WILDCARD = /[?[\]{}()!]/;

export function classifyGlob(glob: string): GlobClass {
	let g = glob.trim();
	if (g.startsWith("!")) return { kind: "unknown" };
	while (g.startsWith("./")) g = g.slice(2);
	const isDir = g.endsWith("/");
	const segments = (isDir ? g.slice(0, -1) : g).split("/");
	if (segments.some((s) => s === "" || s === "." || s === ".."))
		return { kind: "unknown" };
	const literal = (s: string) => !WILDCARD.test(s);

	if (segments.length === 1 && segments[0] === "**") return { kind: "all" };
	if (segments.length === 2 && segments[0] === "**") {
		const leaf = segments[1] ?? "";
		if (leaf === "*") return { kind: "all" };
		if (!leaf.includes("**") && !OTHER_WILDCARD.test(leaf))
			return { kind: "leaf", leaf };
		return { kind: "unknown" };
	}
	if (segments.at(-1) === "**") {
		const dir = segments.slice(0, -1);
		return dir.every(literal)
			? { kind: "prefix", segments: dir }
			: { kind: "unknown" };
	}
	if (!segments.every(literal)) return { kind: "unknown" };
	return isDir ? { kind: "prefix", segments } : { kind: "file", segments };
}

function startsWith(path: string[], prefix: string[]): boolean {
	return prefix.length <= path.length && prefix.every((s, i) => path[i] === s);
}

/** Whether a file name matches a leaf whose only wildcard is *. */
function leafMatches(leaf: string, name: string): boolean {
	const pattern = leaf
		.split("*")
		.map((part) => part.replace(/[.+^$|\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`).test(name);
}

/** A literal leaf, or * followed by literal characters (*.spec.ts). */
function leafSuffix(
	leaf: string,
): { literal: string } | { suffix: string } | null {
	if (!leaf.includes("*")) return { literal: leaf };
	if (leaf.startsWith("*") && !leaf.slice(1).includes("*"))
		return { suffix: leaf.slice(1) };
	return null;
}

function leavesOverlap(a: string, b: string): Overlap {
	const x = leafSuffix(a);
	const y = leafSuffix(b);
	if (!x || !y) return "unknown";
	if ("literal" in x && "literal" in y)
		return x.literal === y.literal ? "overlap" : "disjoint";
	if ("suffix" in x && "suffix" in y)
		// Some name ends in both exactly when one suffix ends with the other.
		return x.suffix.endsWith(y.suffix) || y.suffix.endsWith(x.suffix)
			? "overlap"
			: "disjoint";
	const literal =
		"literal" in x ? x.literal : (y as { literal: string }).literal;
	const suffix = "suffix" in x ? x.suffix : (y as { suffix: string }).suffix;
	return literal.endsWith(suffix) ? "overlap" : "disjoint";
}

/** Whether two globs can match a common path. */
export function globsOverlap(a: string, b: string): Overlap {
	const x = classifyGlob(a);
	const y = classifyGlob(b);
	if (x.kind === "all" || y.kind === "all") return "overlap";
	if (x.kind === "unknown" || y.kind === "unknown") return "unknown";
	if (x.kind === "prefix" && y.kind === "prefix")
		return startsWith(x.segments, y.segments) ||
			startsWith(y.segments, x.segments)
			? "overlap"
			: "disjoint";
	if (x.kind === "file" && y.kind === "file")
		return x.segments.join("/") === y.segments.join("/")
			? "overlap"
			: "disjoint";
	if (x.kind === "leaf" && y.kind === "leaf")
		return leavesOverlap(x.leaf, y.leaf);
	if (x.kind === "leaf" || y.kind === "leaf") {
		const other = x.kind === "leaf" ? y : x;
		const leaf = x.kind === "leaf" ? x.leaf : (y as { leaf: string }).leaf;
		// Some file named like the leaf can always sit under a directory.
		if (other.kind === "prefix") return "overlap";
		const name = (other as { segments: string[] }).segments.at(-1) ?? "";
		return leafMatches(leaf, name) ? "overlap" : "disjoint";
	}
	const file = x.kind === "file" ? x : y;
	const dir = x.kind === "prefix" ? x : y;
	return startsWith(
		(file as { segments: string[] }).segments,
		(dir as { segments: string[] }).segments,
	)
		? "overlap"
		: "disjoint";
}

/**
 * Two writable sets are disjoint only when every pair of globs is. One
 * overlapping pair decides it; otherwise an undecided pair leaves it unknown,
 * which a caller treats as not proven disjoint.
 */
export function pathSetsOverlap(a: string[], b: string[]): Overlap {
	let result: Overlap = "disjoint";
	for (const x of a)
		for (const y of b) {
			const o = globsOverlap(x, y);
			if (o === "overlap") return "overlap";
			if (o === "unknown") result = "unknown";
		}
	return result;
}
