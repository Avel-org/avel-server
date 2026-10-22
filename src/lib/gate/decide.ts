import {
	GATES,
	type Gate,
	type GatePolicy,
	type PlaybookGate,
} from "../../contract/playbook";
import {
	DECIDE_RULES,
	type DecideConfig,
	type DecideRule,
	type Decision,
	type GateDecision,
	type GateFinding,
	type GateOutcome,
	type GateOverride,
	type GateReason,
	type GateResult,
	type IgnoredOverride,
	type NotChecked,
	type ReasonEffect,
} from "./types";

/**
 * Bumped whenever the same inputs could give a different Decision.
 * 2 (2026-10-21): assurance and notChecked.
 * 3 (2026-10-21): one result (verified, pass, fail) replaces verdict and
 * assurance, for the run and for each gate.
 */
export const DECIDE_VERSION = 3;

type Classified = {
	rule: DecideRule;
	effect: Exclude<ReasonEffect, "overridden">;
	overridable: boolean;
	degraded: boolean;
};

/**
 * Turns gate findings into a result (COMMAND-CENTER module 9). Pure: no
 * clock, no ids, and any order of the same inputs gives the same Decision.
 *
 * Each finding gets the first rule that matches:
 * 0. Evidence from another commit than `config.commitSha` is ignored.
 * a. A checkpoint fail blocks, and no override clears it. A checkpoint that
 *    errored or did not run blocks the same way: no violation is proven absent.
 * b. A prior-finding fail blocks, on any gate.
 * c. An open judge finding blocks, on any gate, whatever its severity. It is
 *    cleared by confirming or dismissing it, never by an override. A confirmed
 *    one blocks on any gate too, and an override can clear it. A dismissed
 *    one is a pass, from here on.
 * f. A finding on a gate the playbook does not list is ignored.
 * d. A fail or error blocks on a mandatory gate and warns on a warn gate.
 * e. A not_run blocks on a mandatory gate and warns on a warn gate. A not_run
 *    from a source that is not installed warns instead, tagged degraded.
 * g. Otherwise it passes.
 *
 * A listed gate with no current evidence (judge findings are defects, not
 * evidence) gets a synthesized not_run, which no override clears. An override
 * clears one blocking finding at one commit, with a written rationale.
 *
 * Every finding decide() counts (any effect but ignored) whose check did
 * not run or broke (not_run, error), and every synthesized not_run, is
 * listed in notChecked. The result is resultOf the counted reasons, and
 * every notChecked entry has a reason that did not pass, so a run with a
 * gap is never verified. An override clears a block, never the gap.
 */
export function decide(
	findings: readonly GateFinding[],
	policy: readonly PlaybookGate[],
	overrides: readonly GateOverride[],
	config: DecideConfig,
): Decision {
	const policyOf = new Map<Gate, GatePolicy>();
	for (const p of policy) {
		// A gate listed twice takes the stricter policy, so input order cannot matter.
		if (policyOf.get(p.gate) !== "mandatory") policyOf.set(p.gate, p.policy);
	}
	const available = new Set(config.availableSources);

	const reasons: GateReason[] = [];
	const evidenced = new Set<Gate>();
	const notChecked: NotChecked[] = [];

	for (const f of findings) {
		const gatePolicy = policyOf.get(f.gate) ?? null;
		const c = classify(f, gatePolicy, config.commitSha, available);
		if (c.rule !== "stale_commit" && f.kind !== "judge") evidenced.add(f.gate);
		const outcome = outcomeOf(f);
		if (
			c.effect !== "ignored" &&
			(outcome === "not_run" || outcome === "error")
		) {
			notChecked.push({
				gate: f.gate,
				findingId: f.id,
				kind: f.kind,
				source: f.source,
				outcome,
			});
		}
		const reason: GateReason = {
			gate: f.gate,
			findingId: f.id,
			kind: f.kind,
			source: f.source,
			subject: f.subject,
			policy: gatePolicy,
			rule: c.rule,
			effect: c.effect,
			degraded: c.degraded,
			overridable: c.effect === "block" && c.overridable,
			severity:
				f.kind === "judge"
					? { model: f.severity, operator: f.operatorSeverity }
					: null,
			overrides: [],
			message: messageFor(c.rule, f.subject),
		};
		reasons.push(reason);
	}

	for (const [gate, gatePolicy] of policyOf) {
		if (evidenced.has(gate)) continue;
		const rule =
			gatePolicy === "mandatory" ? "mandatory_not_run" : "warn_not_run";
		const reason: GateReason = {
			gate,
			findingId: `not_run:${gate}`,
			kind: "synthesized",
			source: null,
			subject: gate,
			policy: gatePolicy,
			rule,
			effect: gatePolicy === "mandatory" ? "block" : "warn",
			degraded: false,
			// The gate must run; no rationale stands in for evidence.
			overridable: false,
			severity: null,
			overrides: [],
			message: `The ${gate} gate has no evidence from this commit`,
		};
		reasons.push(reason);
		notChecked.push({
			gate,
			findingId: reason.findingId,
			kind: "synthesized",
			source: null,
			outcome: "not_run",
		});
	}

	const ignoredOverrides: IgnoredOverride[] = [];
	for (const o of [...overrides].sort(compareOverrides)) {
		if (o.commitSha !== config.commitSha) {
			ignoredOverrides.push({ ...o, why: "wrong_commit" });
			continue;
		}
		if (o.rationale.trim() === "") {
			ignoredOverrides.push({ ...o, why: "no_rationale" });
			continue;
		}
		const targets = reasons.filter(
			(r) =>
				r.findingId === o.findingId &&
				(r.effect === "block" || r.effect === "overridden"),
		);
		if (targets.length === 0) {
			ignoredOverrides.push({ ...o, why: "no_such_blocker" });
			continue;
		}
		const clearable = targets.filter((r) => r.overridable);
		if (clearable.length === 0) {
			ignoredOverrides.push({ ...o, why: "not_overridable" });
			continue;
		}
		for (const r of clearable) {
			r.effect = "overridden";
			r.overrides.push(o.rationale);
		}
	}

	reasons.sort(compareReasons);

	const gates: GateDecision[] = [];
	for (const gate of GATES) {
		const gatePolicy = policyOf.get(gate);
		if (gatePolicy === undefined) continue;
		const own = reasons.filter(
			(r) => r.gate === gate && r.effect !== "ignored",
		);
		gates.push({
			gate,
			policy: gatePolicy,
			result: resultOf(own),
			reasons: own,
		});
	}

	notChecked.sort(
		(a, b) =>
			GATES.indexOf(a.gate) - GATES.indexOf(b.gate) ||
			cmp(a.findingId, b.findingId) ||
			cmp(JSON.stringify(a), JSON.stringify(b)),
	);

	const result = resultOf(reasons.filter((r) => r.effect !== "ignored"));
	if (result === "verified" && notChecked.length > 0) {
		throw new Error(
			`decide: verified with ${notChecked.length} unchecked: ${notChecked[0]?.findingId}`,
		);
	}

	return {
		version: DECIDE_VERSION,
		commitSha: config.commitSha,
		result,
		notChecked,
		gates,
		reasons,
		ignoredOverrides,
	};
}

/**
 * The result counted reasons give (GATE_RESULTS): fail if one blocks;
 * verified if there is at least one and every one passed; otherwise pass.
 * No reasons is pass, because nothing was checked. It reads effects only,
 * so a stored run of any decide() version gets its result the same way.
 */
export function resultOf(
	reasons: readonly Pick<GateReason, "effect">[],
): GateResult {
	const counted = reasons.filter((r) => r.effect !== "ignored");
	if (counted.some((r) => r.effect === "block")) return "fail";
	if (counted.length > 0 && counted.every((r) => r.effect === "pass")) {
		return "verified";
	}
	return "pass";
}

/** What the finding's check reported; null for a judge's finding, which is a defect, not a check. */
function outcomeOf(f: GateFinding): GateOutcome | null {
	switch (f.kind) {
		case "judge":
			return null;
		case "judge_coverage":
			// As classify holds it: a pass its own fields contradict is a not_run.
			return f.outcome === "pass" &&
				(f.reportStatus !== "complete" || f.openFindings !== 0)
				? "not_run"
				: f.outcome;
		default:
			return f.outcome;
	}
}

function classify(
	f: GateFinding,
	gatePolicy: GatePolicy | null,
	commitSha: string,
	available: ReadonlySet<string>,
): Classified {
	const result = (
		rule: DecideRule,
		effect: Classified["effect"],
		overridable = true,
		degraded = false,
	): Classified => ({ rule, effect, overridable, degraded });

	if (f.commitSha !== commitSha) return result("stale_commit", "ignored");

	let outcome: GateOutcome;
	switch (f.kind) {
		case "checkpoint":
			// Rule a.
			if (f.outcome === "fail")
				return result("checkpoint_violation", "block", false);
			if (f.outcome !== "pass")
				return result("checkpoint_unproven", "block", false);
			outcome = f.outcome;
			break;
		case "prior_finding":
			// Rule b.
			if (f.outcome === "fail") return result("prior_finding_failed", "block");
			outcome = f.outcome;
			break;
		case "judge":
			// Rule c.
			if (f.status === "open") return result("judge_open", "block", false);
			if (f.status === "confirmed") return result("judge_confirmed", "block");
			outcome = "pass";
			break;
		case "judge_coverage":
			// The type allows pass only for a complete report with no open findings; hold a cast to it.
			outcome =
				f.outcome === "pass" &&
				(f.reportStatus !== "complete" || f.openFindings !== 0)
					? "not_run"
					: f.outcome;
			break;
		case "check":
			outcome = f.outcome;
			break;
	}

	// Rule f.
	if (gatePolicy === null) return result("unlisted_gate", "ignored");
	const mandatory = gatePolicy === "mandatory";
	switch (outcome) {
		// Rule d.
		case "fail":
		case "error":
			return mandatory
				? result("mandatory_failed", "block")
				: result("warn_failed", "warn");
		// Rule e.
		case "not_run":
			if (!available.has(f.source))
				return result("degraded_not_run", "warn", true, true);
			return mandatory
				? result("mandatory_not_run", "block")
				: result("warn_not_run", "warn");
		// Rule g.
		case "pass":
			return result("passed", "pass");
	}
}

function messageFor(rule: DecideRule, subject: string): string {
	switch (rule) {
		case "stale_commit":
			return `${subject}: evidence from another commit`;
		case "checkpoint_violation":
			return `${subject}: written outside the mount; no override clears a violation`;
		case "checkpoint_unproven":
			return `${subject}: the exit checkpoint did not complete`;
		case "prior_finding_failed":
			return `${subject}: a confirmed defect from an earlier mission is present`;
		case "judge_open":
			return `${subject}: a judge's finding is open; confirm or dismiss it`;
		case "judge_confirmed":
			return `${subject}: a judge's finding is a confirmed defect`;
		case "unlisted_gate":
			return `${subject}: the playbook does not list this gate`;
		case "mandatory_failed":
			return `${subject}: failed on a mandatory gate`;
		case "mandatory_not_run":
			return `${subject}: did not run on a mandatory gate`;
		case "degraded_not_run":
			return `${subject}: did not run; its source is not installed`;
		case "warn_failed":
			return `${subject}: failed on a warn gate`;
		case "warn_not_run":
			return `${subject}: did not run on a warn gate`;
		case "passed":
			return `${subject}: passed`;
	}
}

/** Code-unit order, never locale order (DEV-TIPS §2). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareOverrides(a: GateOverride, b: GateOverride): number {
	return (
		cmp(a.findingId, b.findingId) ||
		cmp(a.commitSha, b.commitSha) ||
		cmp(a.rationale, b.rationale)
	);
}

/** Gate, then rule, then every field, so two findings that share an id still sort the same way. */
function compareReasons(a: GateReason, b: GateReason): number {
	return (
		GATES.indexOf(a.gate) - GATES.indexOf(b.gate) ||
		DECIDE_RULES.indexOf(a.rule) - DECIDE_RULES.indexOf(b.rule) ||
		cmp(a.findingId, b.findingId) ||
		cmp(JSON.stringify(a), JSON.stringify(b))
	);
}
