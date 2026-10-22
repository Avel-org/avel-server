import type { CompletionStatus } from "../../contract/shared/status";
import { COMMIT_SHA } from "../../rooms/git";
import { buildIntegrationCommit, dispatchChanges } from "../../rooms/snapshot";
import { type IntegrationDispatch, planIntegration } from "../gate/integration";
import { refuse } from "./refusal";

/**
 * One closed dispatch as the gate read it: its completion status, when it
 * closed (as Date.toISOString() writes it), and its result commit, null
 * when it left none.
 */
export type ClosedDispatch = {
	id: string;
	status: CompletionStatus;
	closedAt: string;
	resultCommitSha: string | null;
};

/**
 * The gate's integration commit, made again from the inputs the gate made
 * it from (src/routes/gate.ts, judge): each closed dispatch's changes from
 * the base, planned with planIntegration and built with
 * buildIntegrationCommit. Plain values in, no database read.
 *
 * Refused (ExportRefused, integration_commit_moved) when the rebuilt sha is
 * not the recorded one. A plan that no longer builds is refused by
 * buildIntegrationCommit (IntegrationRefused), unchanged.
 */
export async function rebuildIntegrationCommit(input: {
	source: string;
	baseSha: string;
	dispatches: readonly ClosedDispatch[];
	recordedSha: string;
}): Promise<{ sha: string }> {
	if (!COMMIT_SHA.test(input.recordedSha)) {
		throw new Error(
			`The recorded commit ${input.recordedSha} is not a full sha`,
		);
	}
	const dispatches: IntegrationDispatch[] = [];
	for (const d of input.dispatches) {
		dispatches.push({
			id: d.id,
			status: d.status,
			closedAt: d.closedAt,
			changes: d.resultCommitSha
				? await dispatchChanges(input.source, input.baseSha, d.resultCommitSha)
				: [],
		});
	}
	const plan = planIntegration({ baseSha: input.baseSha, dispatches });
	const { sha } = await buildIntegrationCommit(input.source, plan);
	if (sha !== input.recordedSha) {
		throw refuse(
			"The integration commit rebuilt is not the one the gate judged",
			{
				reason: "integration_commit_moved",
				recorded: input.recordedSha,
				rebuilt: sha,
			},
		);
	}
	return { sha };
}
