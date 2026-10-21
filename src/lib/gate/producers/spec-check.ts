import { briefSchema } from "../../../contract/intake";
import { checkPlan } from "../../plan-check";
import type { GateFinding } from "../types";
import { byId } from "./shared";

export const SPEC_CHECK_SOURCE = "spec-check";
/** qa, not alignment: alignment is client-contract conformance (J, 2026-10-21). */
export const SPEC_CHECK_GATE = "qa";

/**
 * The qa gate's check on the brief. It reuses the plan check's issues
 * (src/lib/plan-check.ts) rather than restating its rules, and keeps only
 * these:
 * - a requirement with no acceptance criterion (the brief rules' rule 4),
 * - a requirement with no check (plan-check rule 5),
 * - a check citing no requirement, or sharing an id (plan-check rule 5),
 * - a brief with no requirements (the brief rules' rule 2).
 * One finding per requirement, passing or failing, and one per bad check.
 * A brief that does not parse is one error.
 */
export function specCheckFindings(
	brief: unknown,
	commitSha: string,
): GateFinding[] {
	const base = {
		gate: SPEC_CHECK_GATE,
		kind: "check",
		source: SPEC_CHECK_SOURCE,
		commitSha,
	} as const;
	const parsed = briefSchema.safeParse(brief);
	if (!parsed.success) {
		return [
			{
				...base,
				id: "spec-check:brief",
				subject: "The brief does not parse",
				outcome: "error",
			},
		];
	}
	const { requirements, checks } = parsed.data;

	const findings: GateFinding[] = [];
	const failedRequirement = new Map<number, string[]>();
	const failedCheck = new Map<number, string[]>();
	for (const issue of checkPlan(brief)) {
		const [, list, index, field] = issue.path;
		if (list === "requirements" && issue.path.length === 2) {
			// No requirements at all: nothing to align with.
			findings.push({
				...base,
				id: "spec-check:requirements",
				subject: issue.message,
				outcome: "fail",
			});
		}
		if (typeof index !== "number") continue;
		if (
			list === "requirements" &&
			(field === "acceptanceCriteria" || field === "checks")
		) {
			failedRequirement.set(index, [
				...(failedRequirement.get(index) ?? []),
				issue.message,
			]);
		} else if (
			list === "checks" &&
			(field === "requirementId" || field === "id")
		) {
			failedCheck.set(index, [
				...(failedCheck.get(index) ?? []),
				issue.message,
			]);
		}
	}

	requirements.forEach((r, i) => {
		const messages = failedRequirement.get(i);
		findings.push({
			...base,
			id: `spec-check:${r.id}`,
			subject: messages ? messages.join("; ") : r.id,
			outcome: messages ? "fail" : "pass",
		});
	});
	checks.forEach((ck, i) => {
		const messages = failedCheck.get(i);
		if (!messages) return;
		findings.push({
			...base,
			// The index keeps two checks that share an id apart.
			id: `spec-check:${ck.id}:${i}`,
			subject: messages.join("; "),
			outcome: "fail",
		});
	});
	return byId(findings);
}
