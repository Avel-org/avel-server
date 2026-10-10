import type { ZodIssue } from "zod";
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
 * 6. The brief has no modules: the mission's plan adds them (module 3).
 */
export function checkIntake(input: {
	proposedBrief: unknown;
	openQuestions: readonly string[];
	acknowledged?: readonly string[];
}): CheckIssue[] {
	const issues = checkBriefRules(input.proposedBrief, "proposedBrief");
	const at = (...path: Array<string | number>) => ["proposedBrief", ...path];

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

	// Rule 6.
	const brief = briefSchema.safeParse(input.proposedBrief);
	if (brief.success && brief.data.modules.length > 0) {
		issues.push({
			path: at("modules"),
			message: "An intake's brief has no modules; the mission's plan adds them",
		});
	}

	return issues;
}

/**
 * Rules 1 to 4, which the mission's plan check (src/lib/plan-check.ts) shares.
 * Issue paths start at `root`.
 */
export function checkBriefRules(brief: unknown, root: string): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const at = (...path: Array<string | number>) => [root, ...path];

	// Rule 1.
	if (brief === null || brief === undefined) {
		issues.push({ path: at(), message: "There is no brief yet" });
	} else {
		const parsed = briefSchema.safeParse(brief);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				issues.push({ path: at(...issue.path), message: shapeMessage(issue) });
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

	return issues;
}

const FIELD: Record<string, string> = {
	summary: "summary",
	requirements: "requirements",
	acceptanceCriteria: "acceptance criteria",
	modules: "modules",
	id: "id",
	text: "text",
	name: "name",
	requirementId: "requirement it cites",
	requirementIds: "requirement list",
};

const ITEM: Record<string, string> = {
	requirements: "Requirement",
	acceptanceCriteria: "Criterion",
	modules: "Module",
};

/** "The summary", "Requirement 2", "Criterion 1's text": counted from 1. */
function describe(path: ReadonlyArray<string | number>): string {
	const [top, index, field] = path;
	if (top === undefined) return "The brief";
	const topName = FIELD[String(top)] ?? String(top);
	if (typeof index !== "number") return `The ${topName}`;
	const item = `${ITEM[String(top)] ?? topName} ${index + 1}`;
	if (field === undefined) return item;
	return `${item}'s ${FIELD[String(field)] ?? String(field)}`;
}

/**
 * A shape issue in the words the check's other rules use, not zod's. A
 * message the brief schema wrote itself (an id's format) is kept as written.
 */
function shapeMessage(issue: ZodIssue): string {
	switch (issue.code) {
		case "invalid_type":
			if (issue.received === "undefined") {
				return issue.path.length === 1
					? `The brief has no ${FIELD[String(issue.path[0])] ?? issue.path[0]}`
					: `${describe(issue.path)} is missing`;
			}
			return `${describe(issue.path)} is the wrong kind of value`;
		case "too_small":
			return `${describe(issue.path)} is empty`;
		case "too_big":
			return issue.type === "array"
				? `${describe(issue.path)} has more than ${issue.maximum} entries`
				: `${describe(issue.path)} is longer than ${issue.maximum} characters`;
		case "unrecognized_keys":
			return `${describe(issue.path)} has fields the brief does not use: ${issue.keys.join(", ")}`;
		default:
			return issue.message;
	}
}
