import type { BriefCheck } from "../../../contract/intake";
import { matchesGlob, supportedGlob } from "../../../rooms/globs";
import type { GateFinding } from "../types";

export const FILE_EXISTS_SOURCE = "file_exists";
export const BRIEF_CHECKS_GATE = "acceptance";

/** The source of every check that needs a runner. Until one is installed, its not_run degrades. */
export const RUNNER_SOURCE = "runner";

/** The sources of the brief's own checks, which count whether or not the playbook lists their gate. */
export const BRIEF_CHECK_SOURCES = [FILE_EXISTS_SOURCE, RUNNER_SOURCE] as const;

/**
 * The brief's Done-when checks on the acceptance gate, one finding each. A
 * file_exists check passes when its path, or a glob, matches a path the
 * work created or changed: in `head` (path to blob sha at `commitSha`) with
 * a blob `base` does not have at that path (J, 2026-10-21). A matching path
 * the work left as the base had it fails, because the base proves nothing
 * about the work. A glob the matcher does not understand is an error. test,
 * typecheck and command need a runner, so they are not_run from `runner`.
 * In the brief's order, which the ids carry, so the output is as stable as
 * the brief.
 */
export function briefCheckFindings(
	checks: readonly BriefCheck[],
	head: Readonly<Record<string, string>>,
	base: Readonly<Record<string, string>>,
	commitSha: string,
): GateFinding[] {
	const paths = Object.keys(head);
	return checks.map((ck, i): GateFinding => {
		const finding = {
			gate: BRIEF_CHECKS_GATE,
			kind: "check",
			commitSha,
			// The index keeps two checks that share an id apart.
			id: `check:${ck.id}:${i}`,
		} as const;
		if (ck.kind !== "file_exists") {
			return {
				...finding,
				source: RUNNER_SOURCE,
				subject: `${ck.id} (${ck.requirementId}): ${ck.kind} ${ck.command}`,
				outcome: "not_run",
			};
		}
		const subject = `${ck.id} (${ck.requirementId}): ${ck.path}`;
		if (!supportedGlob(ck.path)) {
			return {
				...finding,
				source: FILE_EXISTS_SOURCE,
				subject: `${subject} is not a path the matcher understands`,
				outcome: "error",
			};
		}
		const matching = paths.filter((p) => matchesGlob(p, ck.path));
		const changed = matching.some((p) => base[p] !== head[p]);
		return {
			...finding,
			source: FILE_EXISTS_SOURCE,
			subject: changed
				? subject
				: matching.length > 0
					? `${subject} is unchanged from the base: the work did not create or change it`
					: `${subject} does not exist`,
			outcome: changed ? "pass" : "fail",
		};
	});
}
