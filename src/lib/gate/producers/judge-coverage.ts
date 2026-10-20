import type { FindingStatus } from "../../../contract/agent";
import type { Gate } from "../../../contract/playbook";
import type { CompletionStatus } from "../../../contract/shared/status";
import type { JudgeCoverageFinding } from "../types";
import { byId } from "./shared";

export const JUDGE_COVERAGE_SOURCE = "judge";

/** One judge on the roster, with its latest dispatch, or null when it was never dispatched. */
export type JudgeRun = {
	rosterEntryId: string;
	dispatch: {
		id: string;
		/** The CompletionReport, or null while the dispatch is queued or running. */
		report: { status: CompletionStatus } | null;
	} | null;
};

/** The mission's Findings, as far as coverage needs them. */
export type JudgeFindingRef = {
	reportedByDispatchId: string | null;
	status: FindingStatus;
};

/**
 * Whether each judge ran to the end:
 * - pass: its report is complete and it has no open findings;
 * - fail: its report is complete with open findings, or blocked, or failed;
 * - not_run: it halted, has not reported, or was never dispatched.
 */
export function judgeCoverageFindings(input: {
	judges: readonly JudgeRun[];
	findings: readonly JudgeFindingRef[];
	gate: Gate;
	commitSha: string;
}): JudgeCoverageFinding[] {
	const coverage = input.judges.map((j): JudgeCoverageFinding => {
		const d = j.dispatch;
		const openFindings = d
			? input.findings.filter(
					(f) => f.reportedByDispatchId === d.id && f.status === "open",
				).length
			: 0;
		const base = {
			id: `judge-coverage:${j.rosterEntryId}`,
			gate: input.gate,
			kind: "judge_coverage",
			source: JUDGE_COVERAGE_SOURCE,
			commitSha: input.commitSha,
		} as const;
		const status = d?.report?.status ?? null;
		const subject = d
			? `judge ${j.rosterEntryId}, dispatch ${d.id}: ${status ?? "no report"}, ${openFindings} open`
			: `judge ${j.rosterEntryId}: never dispatched`;
		if (status === null || status === "halted") {
			return {
				...base,
				subject,
				outcome: "not_run",
				reportStatus: status,
				openFindings,
			};
		}
		if (status === "complete" && openFindings === 0) {
			return {
				...base,
				subject,
				outcome: "pass",
				reportStatus: "complete",
				openFindings: 0,
			};
		}
		return {
			...base,
			subject,
			outcome: "fail",
			reportStatus: status,
			openFindings,
		};
	});
	return byId(coverage) as JudgeCoverageFinding[];
}
