import type { BriefCheck } from "../../../contract/intake";
import { matchesGlob, supportedGlob } from "../../../rooms/globs";
import type { GateFinding } from "../types";

export const FILE_EXISTS_SOURCE = "file_exists";
export const BRIEF_CHECKS_GATE = "acceptance";

/** The source of every check that needs a runner. Until one is installed, its not_run degrades. */
export const RUNNER_SOURCE = "runner";

/**
 * The brief's Done-when checks on the acceptance gate, one finding each. A
 * file_exists check passes when its path, or a glob, matches a path in
 * `tree` (path to blob sha at `commitSha`), and fails otherwise. A glob the
 * matcher does not understand is an error. test, typecheck and command need
 * a runner, so they are not_run from `runner`. In the brief's order, which
 * the ids carry, so the output is as stable as the brief.
 */
export function briefCheckFindings(
	checks: readonly BriefCheck[],
	tree: Readonly<Record<string, string>>,
	commitSha: string,
): GateFinding[] {
	const paths = Object.keys(tree);
	return checks.map((ck, i): GateFinding => {
		const base = {
			gate: BRIEF_CHECKS_GATE,
			kind: "check",
			commitSha,
			// The index keeps two checks that share an id apart.
			id: `check:${ck.id}:${i}`,
		} as const;
		if (ck.kind !== "file_exists") {
			return {
				...base,
				source: RUNNER_SOURCE,
				subject: `${ck.id} (${ck.requirementId}): ${ck.kind} ${ck.command}`,
				outcome: "not_run",
			};
		}
		const subject = `${ck.id} (${ck.requirementId}): ${ck.path}`;
		if (!supportedGlob(ck.path)) {
			return {
				...base,
				source: FILE_EXISTS_SOURCE,
				subject: `${subject} is not a path the matcher understands`,
				outcome: "error",
			};
		}
		const found = paths.some((p) => matchesGlob(p, ck.path));
		return {
			...base,
			source: FILE_EXISTS_SOURCE,
			subject: found ? subject : `${subject} does not exist`,
			outcome: found ? "pass" : "fail",
		};
	});
}
