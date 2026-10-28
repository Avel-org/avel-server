import { and, eq, sql } from "drizzle-orm";
import type { ExportStatus } from "../contract/shared/status";
import { logActivity } from "../db/activity";
import { exportTable } from "../db/schema";
import type { Tx } from "../db/tx";
import type { FoundPullRequest } from "../gateways/repo-writer";
import { canTransition } from "../lib/export/delivery";
import type { ExportRow } from "./export-support";
import { operatorOf, type RequestContext, type RouteDeps } from "./shared";

/**
 * How an export's status moves, shared by the export routes and the PR
 * webhook: each move matches the status it read, logs its change, and
 * refuses a move the lifecycle does not allow.
 */
export function exportLifecycle(deps: RouteDeps) {
	/**
	 * Moves an export from `from` to `to` with `set`, logging
	 * export.status_changed as the operator who asked, or as the system when
	 * GitHub told (the PR webhook). The update matches
	 * `from` too, so a request that read a status another has since changed
	 * moves nothing: null, and the caller reads what is there now. Refuses a
	 * move the lifecycle does not allow.
	 */
	async function moveStatus(
		tx: Tx,
		ctx: RequestContext,
		row: ExportRow,
		to: ExportStatus,
		engagementId: string | null,
		set: Partial<typeof exportTable.$inferInsert>,
		by: "operator" | "system" = "operator",
	): Promise<ExportRow | null> {
		const from = row.status;
		if (
			from !== to &&
			!canTransition(from, to, { dryRun: row.dryRun, target: row.targetKind })
		) {
			throw new Error(`export ${row.id} cannot move ${from} -> ${to}`);
		}
		const now = deps.clock.now();
		const [updated] = await tx
			.update(exportTable)
			.set({
				...set,
				status: to,
				// The trigger wants status_changed_at strictly later: a failure in
				// the same millisecond as its insert would otherwise refuse.
				...(from === to
					? {}
					: {
							statusChangedAt: sql`greatest(${now.toISOString()}::timestamptz, ${exportTable.statusChangedAt} + interval '1 millisecond')`,
						}),
				updatedAt: now,
			})
			.where(and(eq(exportTable.id, row.id), eq(exportTable.status, from)))
			.returning();
		if (!updated) return null;
		if (from !== to) {
			await logActivity(tx, deps, {
				...(by === "system"
					? { actorKind: "system" as const }
					: {
							actorKind: "operator" as const,
							actorUserId: operatorOf(ctx).id,
						}),
				action: "export.status_changed",
				entityType: "export",
				entityId: row.id,
				missionId: row.missionId,
				engagementId,
				requestId: ctx.requestId,
				payload: {
					exportId: row.id,
					from,
					to,
					...(set.prNumber ? { prNumber: set.prNumber } : {}),
					...(set.failureCode ? { failureCode: set.failureCode } : {}),
				},
			});
		}
		return updated;
	}

	/** The export as it is now, for a caller whose move found it changed. */
	async function current(tx: Tx, id: string): Promise<ExportRow> {
		const [now] = await tx
			.select()
			.from(exportTable)
			.where(eq(exportTable.id, id));
		if (!now) throw new Error(`export ${id} vanished`);
		return now;
	}

	/**
	 * Records the PR GitHub has for this export: a delivering export becomes
	 * pr-open with it, and a merged or closed PR then moves it on to done or
	 * closed (1, from code review: the lifecycle has no step from delivering
	 * straight to either). Each move matches the status before it.
	 */
	async function recordPullRequest(
		tx: Tx,
		ctx: RequestContext,
		row: ExportRow,
		pr: FoundPullRequest,
		engagementId: string | null,
		by: "operator" | "system" = "operator",
	): Promise<ExportRow> {
		let now = row;
		const fields = {
			prStatus: pr.state,
			prNumber: pr.number,
			prUrl: pr.url,
			prHeadRef: pr.branch,
			prCommitSha: row.prCommitSha ?? pr.commitSha,
		};
		if (now.status === "delivering") {
			const moved = await moveStatus(
				tx,
				ctx,
				now,
				"pr-open",
				engagementId,
				fields,
				by,
			);
			if (!moved) return current(tx, row.id);
			now = moved;
		}
		if (now.status !== "pr-open") return now;
		const to =
			pr.state === "merged"
				? ("done" as const)
				: pr.state === "closed"
					? ("closed" as const)
					: ("pr-open" as const);
		if (to === "pr-open" && now.prStatus === pr.state) return now;
		const moved = await moveStatus(
			tx,
			ctx,
			now,
			to,
			engagementId,
			{ prStatus: pr.state },
			by,
		);
		return moved ?? current(tx, row.id);
	}

	return { moveStatus, current, recordPullRequest };
}
