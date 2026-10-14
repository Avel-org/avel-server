import type { BriefRef } from "../contract/dispatch";
import { type Brief, briefSchema } from "../contract/intake";
import { type CheckIssue, checkBriefRules } from "./intake-check";

/**
 * The mechanical check on a mission's plan (COMMAND-CENTER module 3). Pure:
 * the same brief always gives the same issues, in the same order (rule, then
 * position). An empty list is a pass. Saving a plan does not require a pass;
 * the check reports how far the plan is from one.
 *
 * 1. Intake's brief rules: the shape, at least one requirement, unique ids,
 *    every criterion citing a requirement, every requirement with a criterion.
 * 2. At least one module; module ids are unique.
 * 3. Every requirement a module lists exists, and a module lists it once.
 * 4. Every requirement sits in exactly one module.
 * 5. Every requirement has a check outside the agent (step 9); check ids
 *    are unique, and every check cites an existing requirement.
 */
export function checkPlan(brief: unknown): CheckIssue[] {
	// Rule 1.
	const issues = checkBriefRules(brief, "brief");
	const parsed = briefSchema.safeParse(brief);
	if (!parsed.success) return issues;
	const { requirements, modules } = parsed.data;
	const at = (...path: Array<string | number>) => ["brief", ...path];

	// Rule 2.
	if (modules.length === 0) {
		issues.push({ path: at("modules"), message: "The plan has no modules" });
	}
	const seenModules = new Set<string>();
	modules.forEach((m, i) => {
		if (seenModules.has(m.id)) {
			issues.push({
				path: at("modules", i, "id"),
				message: `Module id ${m.id} is used more than once`,
			});
		}
		seenModules.add(m.id);
	});

	// Rule 3.
	const known = new Set(requirements.map((r) => r.id));
	modules.forEach((m, i) => {
		const listed = new Set<string>();
		m.requirementIds.forEach((rid, j) => {
			if (!known.has(rid)) {
				issues.push({
					path: at("modules", i, "requirementIds", j),
					message: `${m.id} lists ${rid}, which is not a requirement`,
				});
			} else if (listed.has(rid)) {
				issues.push({
					path: at("modules", i, "requirementIds", j),
					message: `${m.id} lists ${rid} more than once`,
				});
			}
			listed.add(rid);
		});
	});

	// Rule 4.
	const owners = new Map<string, string[]>();
	for (const m of modules) {
		for (const rid of new Set(m.requirementIds)) {
			owners.set(rid, [...(owners.get(rid) ?? []), m.id]);
		}
	}
	requirements.forEach((r, i) => {
		const modulesOf = owners.get(r.id) ?? [];
		if (modulesOf.length === 0) {
			issues.push({
				path: at("requirements", i),
				message: `${r.id} is in no module`,
			});
		} else if (modulesOf.length > 1) {
			issues.push({
				path: at("requirements", i),
				message: `${r.id} is in more than one module: ${modulesOf.join(", ")}`,
			});
		}
	});

	// Rule 5.
	const { checks } = parsed.data;
	const seenChecks = new Set<string>();
	checks.forEach((ck, i) => {
		if (seenChecks.has(ck.id)) {
			issues.push({
				path: at("checks", i, "id"),
				message: `Check id ${ck.id} is used more than once`,
			});
		}
		seenChecks.add(ck.id);
		if (!known.has(ck.requirementId)) {
			issues.push({
				path: at("checks", i, "requirementId"),
				message: `${ck.id} cites ${ck.requirementId}, which is not a requirement`,
			});
		}
	});
	const checked = new Set(checks.map((ck) => ck.requirementId));
	requirements.forEach((r, i) => {
		if (!checked.has(r.id)) {
			issues.push({
				path: at("requirements", i, "checks"),
				message: `${r.id} has no check outside the agent`,
			});
		}
	});

	return issues;
}

/**
 * The requirements, of those given, that no check in the brief cites, in
 * the order given. A brief that does not parse has no checks, so every
 * requirement is unchecked. Dispatch create and start refuse
 * requirement_unchecked with these.
 */
export function uncheckedRequirements(
	brief: unknown,
	requirementIds: readonly string[],
): string[] {
	const parsed = briefSchema.safeParse(brief);
	const checked = new Set(
		parsed.success ? parsed.data.checks.map((ck) => ck.requirementId) : [],
	);
	return requirementIds.filter((rid) => !checked.has(rid));
}

/**
 * What a plan changed of the brief the operator approved at Intake. The
 * planner adds requirements, criteria and modules; it never edits or drops
 * an approved one, because their ids are permanent and the approval signed
 * off their text. An empty list means nothing approved changed.
 */
export function approvedBriefChanges(
	approved: Brief,
	next: Brief,
): CheckIssue[] {
	const issues: CheckIssue[] = [];
	if (next.summary !== approved.summary) {
		issues.push({
			path: ["brief", "summary"],
			message: "The summary was approved and cannot change",
		});
	}
	// Every occurrence counts: with ids left unique only by checkPlan, a
	// duplicate could otherwise hide a rewritten copy behind an approved one.
	approved.requirements.forEach((r) => {
		const at = indexesOf(next.requirements, r.id);
		if (at.length === 0) {
			issues.push({
				path: ["brief", "requirements"],
				message: `${r.id} was approved and cannot be removed`,
			});
		} else if (at.length > 1) {
			issues.push({
				path: ["brief", "requirements", at[1] as number, "id"],
				message: `${r.id} was approved and cannot appear more than once`,
			});
		} else if (next.requirements[at[0] as number]?.text !== r.text) {
			issues.push({
				path: ["brief", "requirements", at[0] as number, "text"],
				message: `${r.id} was approved and its text cannot change`,
			});
		}
	});
	approved.acceptanceCriteria.forEach((ac) => {
		const at = indexesOf(next.acceptanceCriteria, ac.id);
		const now = next.acceptanceCriteria[at[0] as number];
		if (at.length === 0) {
			issues.push({
				path: ["brief", "acceptanceCriteria"],
				message: `${ac.id} was approved and cannot be removed`,
			});
		} else if (at.length > 1) {
			issues.push({
				path: ["brief", "acceptanceCriteria", at[1] as number, "id"],
				message: `${ac.id} was approved and cannot appear more than once`,
			});
		} else if (
			now?.text !== ac.text ||
			now?.requirementId !== ac.requirementId
		) {
			issues.push({
				path: ["brief", "acceptanceCriteria", at[0] as number],
				message: `${ac.id} was approved and cannot change`,
			});
		}
	});
	return issues;
}

function indexesOf(items: ReadonlyArray<{ id: string }>, id: string): number[] {
	const found: number[] = [];
	items.forEach((item, i) => {
		if (item.id === id) found.push(i);
	});
	return found;
}

/**
 * requirement_unchecked's issues: one per briefRef requirement no check in
 * the plan cites, at its position in the body.
 */
export function uncheckedIssues(
	brief: unknown,
	ref: Pick<BriefRef, "requirementIds">,
): CheckIssue[] {
	const missing = new Set(uncheckedRequirements(brief, ref.requirementIds));
	return ref.requirementIds.flatMap((rid, i) =>
		missing.has(rid)
			? [
					{
						path: ["briefRef", "requirementIds", i],
						message: `${rid} has no check outside the agent`,
					},
				]
			: [],
	);
}
