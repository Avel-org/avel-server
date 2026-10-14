import { and, desc, eq, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
	DISPATCH_STATUSES,
	type DispatchStatus,
	type TemplateDispatch,
} from "../contract";
import { after, toPage } from "../routes/shared";
import { toDispatchWire } from "./dispatch";
import {
	agentIdentityVersion,
	agentTemplate,
	client,
	completionReport,
	dispatch,
	engagement,
	mission,
	rosterEntry,
} from "./schema";
import { live } from "./schema/columns";
import type { Executor } from "./tx";

/**
 * An agent template's dispatches (GET /api/agent-templates/:id/dispatches):
 * every dispatch of any roster entry built from the template, across its
 * identity versions, on missions the mission detail route shows. A removed
 * roster entry's dispatches stay: a dispatch is evidence. Rows and totals
 * share one filter, so a hidden mission is missing from both.
 */

const versionTemplate = alias(agentTemplate, "td_version_template");

export type TemplateDispatchFilters = {
	status?: DispatchStatus;
	missionId?: string;
};

/** The mission the detail route would show: live, and a client mission's engagement and client live. */
const visibleMission = or(
	eq(mission.origin, "internal"),
	and(isNotNull(engagement.id), isNotNull(client.id)),
) as SQL;

function where(templateId: string, q: TemplateDispatchFilters): SQL {
	return and(
		eq(rosterEntry.agentTemplateId, templateId),
		live(mission),
		visibleMission,
		q.status ? eq(dispatch.status, q.status) : undefined,
		q.missionId ? eq(dispatch.missionId, q.missionId) : undefined,
	) as SQL;
}

export async function templateDispatches(
	db: Executor,
	templateId: string,
	q: TemplateDispatchFilters & { cursor?: string; limit: number },
): Promise<{ items: TemplateDispatch[]; nextCursor: string | null }> {
	const filter = where(templateId, q);
	const rows = await db
		.select({
			row: dispatch,
			territory: rosterEntry.territory,
			agent: {
				templateId: agentTemplate.id,
				slug: agentTemplate.slug,
				name: agentTemplate.name,
				title: agentTemplate.title,
			},
			versionSlug: versionTemplate.slug,
			versionNumber: agentIdentityVersion.number,
			reportId: completionReport.id,
			mission: {
				id: mission.id,
				type: mission.type,
				sprintN: mission.sprintN,
				status: mission.status,
				origin: mission.origin,
			},
			clientId: client.id,
			clientName: client.name,
			report: {
				id: completionReport.id,
				status: completionReport.status,
				filedBy: completionReport.filedBy,
				actualTokens: completionReport.actualTokens,
				blockers: sql<number>`jsonb_array_length(${completionReport.blockers})`,
				edgeMismatches: sql<number>`jsonb_array_length(${completionReport.edgeMismatches})`,
			},
		})
		.from(dispatch)
		.innerJoin(rosterEntry, eq(rosterEntry.id, dispatch.rosterEntryId))
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.innerJoin(mission, eq(mission.id, dispatch.missionId))
		.leftJoin(
			engagement,
			and(eq(engagement.id, mission.engagementId), live(engagement)),
		)
		.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.leftJoin(
			agentIdentityVersion,
			eq(agentIdentityVersion.id, dispatch.agentIdentityVersionId),
		)
		.leftJoin(
			versionTemplate,
			eq(versionTemplate.id, agentIdentityVersion.agentTemplateId),
		)
		.leftJoin(
			completionReport,
			and(eq(completionReport.dispatchId, dispatch.id), live(completionReport)),
		)
		.where(and(filter, after(dispatch, q.cursor)))
		.orderBy(desc(dispatch.createdAt), desc(dispatch.id))
		.limit(q.limit + 1);
	const { items, nextCursor } = toPage(
		rows.map((r) => ({ createdAt: r.row.createdAt, id: r.row.id, r })),
		q.limit,
	);
	return {
		items: items.map(({ r }) => ({
			...toDispatchWire(r),
			mission: {
				id: r.mission.id,
				type: r.mission.type,
				sprintN: r.mission.sprintN,
				status: r.mission.status,
				origin: r.mission.origin,
				client:
					r.clientId !== null && r.clientName !== null
						? { id: r.clientId, name: r.clientName }
						: null,
			},
			// Drizzle answers a left-joined object as null when its row is absent.
			report:
				r.report !== null
					? {
							id: r.report.id,
							status: r.report.status,
							filedBy: r.report.filedBy,
							actualTokens: r.report.actualTokens,
							blockers: Number(r.report.blockers),
							edgeMismatches: Number(r.report.edgeMismatches),
						}
					: null,
		})),
		nextCursor,
	};
}

export type TemplateDispatchTotals = {
	total: number;
	byStatus: Record<DispatchStatus, number>;
	spendUsd: number;
	tokensUsed: number;
	estimatedTokens: number;
};

/**
 * The totals the filters keep, whatever the cursor. Sums are taken in
 * Postgres: spend as numeric, so the total is exact to six places before
 * it becomes a number, and the token counts as bigint.
 */
export async function templateDispatchTotals(
	db: Executor,
	templateId: string,
	q: TemplateDispatchFilters,
): Promise<TemplateDispatchTotals> {
	const groups = await db
		.select({
			status: dispatch.status,
			n: sql<number>`count(*)`.mapWith(Number),
		})
		.from(dispatch)
		.innerJoin(rosterEntry, eq(rosterEntry.id, dispatch.rosterEntryId))
		.innerJoin(mission, eq(mission.id, dispatch.missionId))
		.leftJoin(
			engagement,
			and(eq(engagement.id, mission.engagementId), live(engagement)),
		)
		.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(where(templateId, q))
		.groupBy(dispatch.status);
	const [sums] = await db
		.select({
			spendUsd: sql<string>`coalesce(sum(${dispatch.spendUsd}), 0)::text`,
			tokensUsed: sql<string>`coalesce(sum(${dispatch.tokensUsed}), 0)::text`,
			estimatedTokens: sql<string>`coalesce(sum(${dispatch.estimatedTokens}), 0)::text`,
		})
		.from(dispatch)
		.innerJoin(rosterEntry, eq(rosterEntry.id, dispatch.rosterEntryId))
		.innerJoin(mission, eq(mission.id, dispatch.missionId))
		.leftJoin(
			engagement,
			and(eq(engagement.id, mission.engagementId), live(engagement)),
		)
		.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(where(templateId, q));
	const byStatus = Object.fromEntries(
		DISPATCH_STATUSES.map((s) => [s, 0]),
	) as Record<DispatchStatus, number>;
	for (const g of groups) byStatus[g.status] = g.n;
	return {
		total: groups.reduce((n, g) => n + g.n, 0),
		byStatus,
		spendUsd: Number(sums?.spendUsd ?? 0),
		tokensUsed: Number(sums?.tokensUsed ?? 0),
		estimatedTokens: Number(sums?.estimatedTokens ?? 0),
	};
}
