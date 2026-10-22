import type { FindingSeverity, FindingStatus } from "../../contract/agent";
import type {
	DECIDE_RULES,
	GATE_FINDING_KINDS,
	GATE_RESULTS,
	IGNORED_OVERRIDE_WHYS,
	REASON_EFFECTS,
} from "../../contract/gate";
import type { Gate, GatePolicy } from "../../contract/playbook";
import type { CompletionStatus } from "../../contract/shared/status";

/** What a check reported. `error` is a check that ran and broke; `not_run` never ran. */
export const GATE_OUTCOMES = ["pass", "fail", "error", "not_run"] as const;

export type GateOutcome = (typeof GATE_OUTCOMES)[number];

// The gate's vocabulary is defined once, in the contract (src/contract/gate.ts).
export {
	DECIDE_RULES,
	GATE_FINDING_KINDS,
	GATE_RESULTS,
	IGNORED_OVERRIDE_WHYS,
	REASON_EFFECTS,
} from "../../contract/gate";

export type GateFindingKind = (typeof GATE_FINDING_KINDS)[number];

type FindingBase = {
	/** Unique per finding. An override binds to it. */
	id: string;
	gate: Gate;
	/** The tool that produced it, matched against `DecideConfig.availableSources`. */
	source: string;
	/** The commit the evidence was taken from. Any other commit than the one decided is stale. */
	commitSha: string;
	/** What was checked: a path, a test, a scenario. */
	subject: string;
};

/** A test run, the mutation floor, an accessibility scan, a fuzz run: any mechanical check. */
export type CheckFinding = FindingBase & {
	kind: "check";
	outcome: GateOutcome;
};

/** The room's exit checkpoint. A fail is a violation: a write where the agent was not permitted. */
export type CheckpointFinding = FindingBase & {
	kind: "checkpoint";
	outcome: GateOutcome;
};

/** A confirmed Finding from an earlier mission, run as a check on this one. */
export type PriorFinding = FindingBase & {
	kind: "prior_finding";
	outcome: GateOutcome;
};

/**
 * A defect a judge recorded (the Finding entity). The model's severity and the
 * operator's re-grade are kept apart; neither changes the verdict at version 1.
 */
export type JudgeFinding = FindingBase & {
	kind: "judge";
	status: FindingStatus;
	/** As the judge wrote it. */
	severity: FindingSeverity;
	/** As the operator re-graded it, or null when it has not been re-graded. */
	operatorSeverity: FindingSeverity | null;
};

/**
 * Whether the judge ran to the end. `pass` only when its CompletionReport is
 * complete with zero open findings; `not_run` when it halted or was never
 * dispatched (`reportStatus` null). The producer is not built.
 */
export type JudgeCoverageFinding = FindingBase & {
	kind: "judge_coverage";
} & (
		| { outcome: "pass"; reportStatus: "complete"; openFindings: 0 }
		| {
				outcome: "fail";
				reportStatus: Exclude<CompletionStatus, "halted">;
				openFindings: number;
		  }
		| {
				outcome: "not_run";
				reportStatus: "halted" | null;
				openFindings: number;
		  }
	);

export type GateFinding =
	| CheckFinding
	| CheckpointFinding
	| PriorFinding
	| JudgeFinding
	| JudgeCoverageFinding;

/** An operator's written decision to ship past one blocking finding at one commit. */
export type GateOverride = {
	findingId: string;
	commitSha: string;
	rationale: string;
};

export type DecideConfig = {
	/** The commit being decided. */
	commitSha: string;
	/** Sources installed on this machine. A `not_run` from any other degrades to a warn. */
	availableSources: readonly string[];
};

export type DecideRule = (typeof DECIDE_RULES)[number];

export type ReasonEffect = (typeof REASON_EFFECTS)[number];

export type GateReason = {
	gate: Gate;
	/** For a synthesized `not_run`, `not_run:<gate>`. */
	findingId: string;
	/** `synthesized` when the gate had no evidence at all. */
	kind: GateFindingKind | "synthesized";
	source: string | null;
	subject: string;
	policy: GatePolicy | null;
	rule: DecideRule;
	effect: ReasonEffect;
	/** A `not_run` from a source that is not installed. */
	degraded: boolean;
	/**
	 * True exactly when the reason blocks and a written override at the decided
	 * commit clears it. An overridden reason keeps true; any other effect is false.
	 */
	overridable: boolean;
	/** Judge findings only. */
	severity: { model: FindingSeverity; operator: FindingSeverity | null } | null;
	/** The rationales of the overrides applied, sorted. Empty unless `effect` is `overridden`. */
	overrides: string[];
	message: string;
};

export type GateResult = (typeof GATE_RESULTS)[number];

export type GateDecision = {
	gate: Gate;
	policy: GatePolicy;
	result: GateResult;
	reasons: GateReason[];
};

export type IgnoredOverride = GateOverride & {
	why: (typeof IGNORED_OVERRIDE_WHYS)[number];
};

/** A counted finding that did not check: it did not run, or it broke. */
export type NotChecked = {
	gate: Gate;
	findingId: string;
	kind: GateFindingKind | "synthesized";
	source: string | null;
	outcome: "not_run" | "error";
};

export type Decision = {
	version: number;
	commitSha: string;
	/** resultOf(reasons). Never verified while `notChecked` has an entry. */
	result: GateResult;
	/** Every counted finding that did not check, in GATES order, then by id. */
	notChecked: NotChecked[];
	/** Listed gates, and an unlisted gate holding the brief's checks (as mandatory), in GATES order. */
	gates: GateDecision[];
	/** Every reason, unlisted and stale ones included, sorted. */
	reasons: GateReason[];
	ignoredOverrides: IgnoredOverride[];
};
