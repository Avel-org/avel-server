import { briefSchema } from "../contract/intake";

export type CheckIssue = { path: Array<string | number>; message: string };

/**
 * The mechanical check on an intake (COMMAND-CENTER module 1). It runs at
 * propose and again at approve; only approve passes `acknowledged`, which
 * adds rule 5. Pure: the same input always gives the same issues, in the
 * same order (rule, then position). An empty list is a pass.
 *
 * 1. The brief exists and has the brief shape.
 * 2. It has at least one requirement; requirement and criterion ids are unique.
 * 3. Every criterion cites a requirement that exists.
 * 4. Every requirement has at least one criterion.
 * 5. (approve) The acknowledged questions are exactly the open questions.
 */
export function checkIntake(input: {
	proposedBrief: unknown;
	openQuestions: readonly string[];
	acknowledged?: readonly string[];
}): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const at = (...path: Array<string | number>) => ["proposedBrief", ...path];

	// Rule 1.
	if (input.proposedBrief === null || input.proposedBrief === undefined) {
		issues.push({ path: at(), message: "There is no brief yet" });
	} else {
		const parsed = briefSchema.safeParse(input.proposedBrief);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				issues.push({ path: at(...issue.path), message: issue.message });
			}
		} else {
			const { requirements, acceptanceCriteria } = parsed.data;

			// Rule 2.
			if (requirements.length === 0) {
				issues.push({
					path: at("requirements"),
					message: "The brief has no requirements",
				});
			}
			const seen = new Set<string>();
			requirements.forEach((r, i) => {
				if (seen.has(r.id)) {
					issues.push({
						path: at("requirements", i, "id"),
						message: `Requirement id ${r.id} is used more than once`,
					});
				}
				seen.add(r.id);
			});
			const seenCriteria = new Set<string>();
			acceptanceCriteria.forEach((ac, i) => {
				if (seenCriteria.has(ac.id)) {
					issues.push({
						path: at("acceptanceCriteria", i, "id"),
						message: `Criterion id ${ac.id} is used more than once`,
					});
				}
				seenCriteria.add(ac.id);
			});

			// Rule 3.
			acceptanceCriteria.forEach((ac, i) => {
				if (!seen.has(ac.requirementId)) {
					issues.push({
						path: at("acceptanceCriteria", i, "requirementId"),
						message: `${ac.id} cites ${ac.requirementId}, which is not a requirement`,
					});
				}
			});

			// Rule 4.
			const covered = new Set(acceptanceCriteria.map((ac) => ac.requirementId));
			requirements.forEach((r, i) => {
				if (!covered.has(r.id)) {
					issues.push({
						path: at("requirements", i),
						message: `${r.id} has no acceptance criterion`,
					});
				}
			});
		}
	}

	// Rule 5.
	if (input.acknowledged) {
		const acknowledged = new Set(input.acknowledged);
		const open = new Set(input.openQuestions);
		input.openQuestions.forEach((q, i) => {
			if (!acknowledged.has(q)) {
				issues.push({
					path: ["openQuestions", i],
					message: `Open question is neither answered nor acknowledged: ${q}`,
				});
			}
		});
		input.acknowledged.forEach((q, i) => {
			if (!open.has(q)) {
				issues.push({
					path: ["acknowledged", i],
					message: `Acknowledged a question that is not open: ${q}`,
				});
			}
		});
	}

	return issues;
}
