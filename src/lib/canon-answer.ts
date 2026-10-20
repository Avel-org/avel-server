import { z } from "zod";
import type { CheckIssue } from "./intake-check";

/** The answer an operator gives a CanonQuestion (DATA-CONTRACTS-V2, *CanonQuestion*). */
const answerShape = z
	.object({
		selected: z.array(z.string()),
		other: z.string().optional(),
	})
	.strict();

export type CanonAnswer = z.infer<typeof answerShape>;

/**
 * The rules an answer must pass before a question is answered. Pure: the
 * same input gives the same issues in the same order (shape, then other,
 * then each label by position, then the count). An empty list is a pass.
 *
 * 1. The answer is `{ selected: string[], other?: string }` and nothing else.
 * 2. `other`, when given, is not blank. Free text is always allowed.
 * 3. Every selected label is one of the question's options, exactly as
 *    written, and none is given twice.
 * 4. A single-select question takes exactly one label, or `other` alone in
 *    place of one. A multi-select question takes one or more labels, `other`,
 *    or both. An answer with neither is no answer.
 */
export function checkCanonAnswer(
	question: {
		options: readonly { label: string }[];
		multiSelect: boolean;
	},
	answer: unknown,
): CheckIssue[] {
	const parsed = answerShape.safeParse(answer);
	if (!parsed.success) {
		return parsed.error.issues.map((issue) => ({
			path: ["answer", ...issue.path],
			message: issue.message,
		}));
	}
	const { selected, other } = parsed.data;
	const issues: CheckIssue[] = [];

	// Rule 2.
	if (other !== undefined && other.trim() === "") {
		issues.push({
			path: ["answer", "other"],
			message: "other must not be blank; leave it out instead",
		});
	}

	// Rule 3.
	const offered = new Set(question.options.map((o) => o.label));
	const seen = new Set<string>();
	selected.forEach((label, i) => {
		if (!offered.has(label)) {
			issues.push({
				path: ["answer", "selected", i],
				message: `"${label}" is not one of this question's options`,
			});
		} else if (seen.has(label)) {
			issues.push({
				path: ["answer", "selected", i],
				message: `"${label}" is selected twice`,
			});
		}
		seen.add(label);
	});

	// Rule 4. A blank other is already refused above, so it counts as given
	// here and the answer gets one issue, not two.
	const hasOther = other !== undefined;
	if (selected.length === 0 && !hasOther) {
		issues.push({
			path: ["answer", "selected"],
			message: "Select an option or give another answer",
		});
	} else if (
		!question.multiSelect &&
		(selected.length > 1 || (selected.length === 1 && hasOther))
	) {
		issues.push({
			path: ["answer", "selected"],
			message:
				"This question takes one answer: one option, or another answer in its place",
		});
	}
	return issues;
}
