import { asc, eq } from "drizzle-orm";
import { completionReport, dispatch } from "../db/schema";
import type { Executor } from "../db/tx";
import {
	type IntegrationConflict,
	type IntegrationDispatch,
	planIntegration,
} from "../lib/gate/integration";
import { buildIntegrationCommit, dispatchChanges } from "../rooms/snapshot";

/**
 * Where a dispatch's room starts (decided 2026-10-22: rooms start from
 * finished work): the mission's base plus every complete dispatch closed
 * before the start, in close order, built as the gate builds its
 * integration commit. A later wave sees the earlier waves' code, and a
 * retry sees a fix made meanwhile.
 */

/** A dispatch row, as both the start and the gate read it for integration. */
export type IntegrationRow = {
	id: string;
	reportStatus: IntegrationDispatch["status"] | null;
	closedAt: Date | null;
	resultCommitSha: string | null;
	startCommitSha: string | null;
	startDispatchIds: string[] | null;
};

/**
 * The closed dispatches among `rows`, each with what it changed since the
 * commit it started from: its own start, or the base for one started
 * before starts were recorded. One with no result commit changed nothing
 * that can be laid down.
 */
export async function integrationDispatches(
	source: string,
	baseSha: string,
	rows: readonly IntegrationRow[],
): Promise<IntegrationDispatch[]> {
	const out: IntegrationDispatch[] = [];
	for (const d of rows) {
		if (d.reportStatus === null || d.closedAt === null) continue;
		const startSha = d.startCommitSha ?? baseSha;
		out.push({
			id: d.id,
			status: d.reportStatus,
			closedAt: d.closedAt.toISOString(),
			changes: d.resultCommitSha
				? await dispatchChanges(source, startSha, d.resultCommitSha)
				: [],
			...(d.startCommitSha
				? { startSha: d.startCommitSha, saw: d.startDispatchIds ?? [] }
				: {}),
		});
	}
	return out;
}

export type StartCommit =
	| { ok: true; sha: string; dispatchIds: string[] }
	| {
			ok: false;
			reason: "integration_conflict";
			conflicts: IntegrationConflict[];
	  };

/**
 * The commit a new dispatch of the mission starts from, and the complete
 * dispatches it was built from. The base itself when none has completed.
 * Refused, as the gate refuses, when two of them changed a path neither
 * saw the other change. A complete dispatch with no result commit (one
 * closed before result commits) holds nothing to lay down, so it is left out and not listed; the gate still refuses it.
 */
export async function startCommit(
	db: Executor,
	missionId: string,
	source: string,
	baseSha: string,
): Promise<StartCommit> {
	const rows = await db
		.select({
			id: dispatch.id,
			reportStatus: completionReport.status,
			closedAt: dispatch.closedAt,
			resultCommitSha: completionReport.resultCommitSha,
			startCommitSha: dispatch.startCommitSha,
			startDispatchIds: dispatch.startDispatchIds,
		})
		.from(dispatch)
		.leftJoin(completionReport, eq(completionReport.dispatchId, dispatch.id))
		.where(eq(dispatch.missionId, missionId))
		.orderBy(asc(dispatch.id));
	const laid = rows.filter(
		(d) => !(d.reportStatus === "complete" && d.resultCommitSha === null),
	);
	const plan = planIntegration({
		baseSha,
		dispatches: await integrationDispatches(source, baseSha, laid),
	});
	if (!plan.ok) {
		return {
			ok: false,
			reason: "integration_conflict",
			conflicts: plan.conflicts,
		};
	}
	if (plan.steps.length === 0) {
		return { ok: true, sha: baseSha, dispatchIds: [] };
	}
	const built = await buildIntegrationCommit(source, plan);
	return {
		ok: true,
		sha: built.sha,
		dispatchIds: plan.steps.map((s) => s.dispatchId),
	};
}
