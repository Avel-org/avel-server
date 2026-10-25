import type { PermanentCheck } from "../../../contract/agent";
import type { Gate } from "../../../contract/playbook";
import { matchesGlob } from "../../../rooms/globs";
import type { GateFinding } from "../types";

export const PRIOR_FINDING_SOURCE = "prior-finding";

/** A confirmed finding from an earlier mission, with the check it carries. */
export type PriorCheck = {
	findingId: string;
	missionId: string;
	subject: string;
	check: PermanentCheck;
};

/** A file the work added or changed: its text, or null when it was too large to read whole. */
export type ChangedText = { path: string; text: string | null };

/**
 * Module 12 (J, 2026-10-24): each confirmed finding's permanent check, run
 * on what this mission's work changed, never the base's own files. One
 * prior_finding per check, id prior:<finding id>:
 * - fail when a changed file under its paths holds its text, literally;
 * - not_run when none does but a matching file was too large to read, so
 *   the check cannot be shown to hold;
 * - pass otherwise, including when no changed file is under its paths.
 * Pure: the same checks and files give the same findings, in id order.
 */
export function priorFindingFindings(input: {
	checks: readonly PriorCheck[];
	changed: readonly ChangedText[];
	gate: Gate;
	commitSha: string;
}): GateFinding[] {
	const out: GateFinding[] = input.checks.map((c) => {
		const under = input.changed.filter((f) =>
			c.check.paths.some((g) => matchesGlob(f.path, g)),
		);
		const hits = under
			.filter((f) => f.text?.includes(c.check.text))
			.map((f) => f.path);
		const unread = under.filter((f) => f.text === null).map((f) => f.path);
		const named = `${c.subject} (finding ${c.findingId}, mission ${c.missionId})`;
		const outcome =
			hits.length > 0 ? "fail" : unread.length > 0 ? "not_run" : "pass";
		const subject =
			outcome === "fail"
				? `${named}: ${JSON.stringify(c.check.text)} is back in ${hits.join(", ")}`
				: outcome === "not_run"
					? `${named}: too large to read whole: ${unread.join(", ")}`
					: named;
		return {
			kind: "prior_finding",
			id: `prior:${c.findingId}`,
			gate: input.gate,
			source: PRIOR_FINDING_SOURCE,
			commitSha: input.commitSha,
			subject,
			outcome,
		};
	});
	return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
