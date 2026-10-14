import type { BriefRef } from "../contract/dispatch";
import type { Brief, BriefCheck } from "../contract/intake";
import { canonicalJson } from "../lib/canonical";
import { sha256Hex } from "../lib/tokens";
import type { ReadMatch } from "../rooms/read-set";

/**
 * The dispatch brief (step 9; docs/STEP-9-PLAN.md): Scope, Read, Method and
 * Done when, rendered from the plan. Pure and deterministic: the same input
 * always renders the same text, so the brief frozen at start can be
 * re-rendered and compared. briefSha256 is the hash of that text, and the
 * text carries every Read file's blob sha, the read set's own hash and the
 * client source's hash, so the one hash covers what the agent was told to
 * read as well as what it was told.
 */

/** A skill as the Method section lists it. */
export type BriefSkill = { slug: string; name: string; description: string };

export type BriefInput = {
	/** The mission's plan. */
	plan: Brief;
	/** What the dispatch is for: its module and requirements. */
	ref: BriefRef;
	/** The room's commit, which the Read paths are read at. */
	commit: string;
	/** The module's reads matched at the commit, in the module's order. */
	reads: readonly ReadMatch[];
	/** The approved intake's sourceMd, or null when the mission has none. */
	sourceMd: string | null;
	/** The dispatch's stack and domain skills (dispatchSkillSet). */
	skills: readonly BriefSkill[];
};

/** The Read section lists at most this many files; the read set's hash covers them all. */
export const READ_LIST_CAP = 500;

/** The hash of a rendered brief: briefSha256 on the dispatch. */
export function briefSha256(briefMd: string): string {
	return sha256Hex(briefMd);
}

/**
 * The hex SHA-256 of canonicalJson of the read set: every read with every
 * file it matched, listed or not.
 */
export function readSetSha256(reads: readonly ReadMatch[]): string {
	return sha256Hex(
		canonicalJson(
			reads.map((r) => ({
				read: r.read,
				files: r.files.map((f) => ({ path: f.path, blobSha: f.blobSha })),
			})),
		),
	);
}

/** One line of free text: the first line, trimmed. */
function oneLine(text: string): string {
	return (text.trim().split(/\r?\n/)[0] ?? "").trim();
}

/** A code fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
	const longest = Math.max(
		0,
		...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
	);
	return "`".repeat(Math.max(3, longest + 1));
}

/** Inline code that survives backticks inside it. */
function code(text: string): string {
	const longest = Math.max(
		0,
		...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
	);
	const ticks = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${ticks}${pad}${text}${pad}${ticks}`;
}

function checkLine(ck: BriefCheck): string {
	const what =
		ck.kind === "file_exists"
			? `${code(ck.path)} exists`
			: `${code(ck.command)} passes`;
	const note = ck.note ? ` ${ck.note}` : "";
	return `- ${ck.id} (${ck.requirementId}, ${ck.kind}): ${what}.${note}`;
}

/**
 * The brief as markdown. Throws when the plan has no module `ref.moduleId`
 * or does not hold one of its requirements: dispatch create refuses both,
 * and a plan only changes while its mission is a draft.
 */
export function renderBrief(input: BriefInput): string {
	const { plan, ref } = input;
	const module = plan.modules.find((m) => m.id === ref.moduleId);
	if (!module) throw new Error(`the plan has no module ${ref.moduleId}`);
	const requirements = ref.requirementIds.map((rid) => {
		const r = plan.requirements.find((x) => x.id === rid);
		if (!r) throw new Error(`the plan has no requirement ${rid}`);
		return r;
	});
	const ids = new Set(ref.requirementIds);
	const lines: string[] = [];

	lines.push(`# ${module.id}: ${module.name}`, "", plan.summary, "");

	lines.push("## Scope", "");
	lines.push(
		`Do module ${module.id}, ${module.name}, for these requirements and nothing else.`,
		"",
	);
	for (const r of requirements) {
		lines.push(`### ${r.id}`, "", r.text, "");
		const criteria = plan.acceptanceCriteria.filter(
			(ac) => ac.requirementId === r.id,
		);
		for (const ac of criteria) lines.push(`- ${ac.id}: ${ac.text}`);
		if (criteria.length > 0) lines.push("");
	}

	lines.push("## Read", "");
	lines.push(`Repository paths at commit ${code(input.commit)}.`, "");
	if (input.reads.length === 0) {
		lines.push("The module names no repository paths.", "");
	} else {
		let listed = 0;
		for (const r of input.reads) {
			if (r.files.length === 0) {
				lines.push(`- ${code(r.read)}: matches nothing at this commit`);
				continue;
			}
			lines.push(`- ${code(r.read)}: ${r.files.length} files`);
			const room = Math.max(0, READ_LIST_CAP - listed);
			for (const f of r.files.slice(0, room)) {
				lines.push(`  - ${code(f.path)} ${f.blobSha}`);
			}
			listed += Math.min(room, r.files.length);
			if (r.files.length > room) {
				lines.push(`  - and ${r.files.length - room} more, not listed`);
			}
		}
		lines.push("", `Read set sha256: ${readSetSha256(input.reads)}`, "");
	}
	lines.push("### Client source", "");
	if (input.sourceMd === null) {
		lines.push("The mission has no client source.", "");
	} else {
		const fence = fenceFor(input.sourceMd);
		lines.push(
			`sha256: ${sha256Hex(input.sourceMd)}`,
			"",
			`${fence}markdown`,
			input.sourceMd,
			fence,
			"",
		);
	}

	lines.push("## Method", "");
	if (input.skills.length === 0) {
		lines.push("No stack or domain skills apply.", "");
	} else {
		lines.push(
			"Read a skill's full text by its slug before you rely on it.",
			"",
		);
		for (const s of input.skills) {
			const about = oneLine(s.description);
			lines.push(`- ${code(s.slug)}, ${s.name}${about ? `: ${about}` : ""}`);
		}
		lines.push("");
	}

	lines.push("## Done when", "");
	lines.push(
		"Each check runs outside you. Your word that the work is done does not count.",
		"",
	);
	for (const ck of plan.checks.filter((c) => ids.has(c.requirementId))) {
		lines.push(checkLine(ck));
	}

	return `${lines.join("\n").trimEnd()}\n`;
}
