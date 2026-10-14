import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
	type ActivityActor,
	type ActivityEntry,
	activityContract,
} from "../contract";
import { touchesClient } from "../db/activity";
import { activityLog, agentTemplate, rosterEntry, user } from "../db/schema";
import { after, type RequestContext, type RouteDeps, toPage } from "./shared";

/**
 * The columns every actor wire reads (activity, a mission's recent
 * activity, a preset's applications). Select them with activity_log
 * left-joined to user on actor_user_id, roster_entry on
 * actor_roster_entry_id, and agent_template on the entry's template, with
 * no live(): a removed entry or template still names who acted.
 */
export const actorColumns = {
	id: activityLog.id,
	actorKind: activityLog.actorKind,
	actorUserId: activityLog.actorUserId,
	actorRosterEntryId: activityLog.actorRosterEntryId,
	login: user.githubLogin,
	agentTemplateId: agentTemplate.id,
	agentSlug: agentTemplate.slug,
	agentName: agentTemplate.name,
	territory: rosterEntry.territory,
};

/** One row of actorColumns. */
export type ActorRow = {
	id: string;
	actorKind: ActivityActor["kind"];
	actorUserId: string | null;
	actorRosterEntryId: string | null;
	login: string | null;
	agentTemplateId: string | null;
	agentSlug: string | null;
	agentName: string | null;
	territory: string | null;
};

type Row = typeof activityLog.$inferSelect & ActorRow;

/** What the runner is called wherever an actor is shown. */
export const RUNNER_DISPLAY = "AVEL runner";

/**
 * The actor's label. The CHECKs on activity_log tie each kind to its foreign
 * key, and the foreign keys keep the joined rows, so a missing name is a
 * broken row: a 500, never a made-up label.
 */
export function actorDisplay(row: ActorRow): string {
	switch (row.actorKind) {
		case "system":
			return RUNNER_DISPLAY;
		case "operator":
			if (row.login === null)
				throw new Error(`activity ${row.id}: operator has no user row`);
			return row.login;
		case "agent":
			if (row.agentName === null)
				throw new Error(`activity ${row.id}: agent has no template row`);
			return row.territory
				? `${row.agentName} · ${row.territory}`
				: row.agentName;
	}
}

/**
 * The actor, as all three actor wires show it: its kind, the operator's
 * user id, the agent's roster entry, the label, and for an agent its
 * template and territory. One function, so the wires cannot drift.
 */
export function activityActor(row: ActorRow): ActivityActor {
	const base = {
		kind: row.actorKind,
		userId: row.actorUserId,
		rosterEntryId: row.actorRosterEntryId,
		display: actorDisplay(row),
	};
	if (row.actorKind !== "agent") return { ...base, agent: null };
	if (row.agentTemplateId === null || row.agentSlug === null) {
		throw new Error(`activity ${row.id}: agent has no template row`);
	}
	return {
		...base,
		agent: {
			templateId: row.agentTemplateId,
			slug: row.agentSlug,
			name: row.agentName as string,
			territory: row.territory,
		},
	};
}

/** The keyset position shared.ts pages on: (at desc, id desc) here. */
const position = { createdAt: activityLog.at, id: activityLog.id };

/** Database row (snake_case columns, Dates) to wire shape (camelCase, ISO strings). */
function toWire(row: Row): ActivityEntry {
	return {
		id: row.id,
		at: row.at.toISOString(),
		actorKind: row.actorKind,
		actorUserId: row.actorUserId,
		actorRosterEntryId: row.actorRosterEntryId,
		action: row.action,
		entityType: row.entityType,
		entityId: row.entityId,
		missionId: row.missionId,
		engagementId: row.engagementId,
		requestId: row.requestId,
		payload: row.payload as Record<string, unknown>,
		actor: activityActor(row),
	};
}

/**
 * ActivityLog is append-only and has no deleted_at, so there is no live()
 * filter: a row stays listed after the entity it names is removed.
 */
export function activityRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(activityContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = and(
				query.missionId
					? eq(activityLog.missionId, query.missionId)
					: undefined,
				query.engagementId
					? eq(activityLog.engagementId, query.engagementId)
					: undefined,
				query.entityType
					? eq(activityLog.entityType, query.entityType)
					: undefined,
				query.clientId
					? touchesClient(sql`${query.clientId}::uuid`)
					: undefined,
				query.entityId
					? inArray(activityLog.entityId, query.entityId)
					: undefined,
				query.actorKind
					? eq(activityLog.actorKind, query.actorKind)
					: undefined,
			);
			// The page and the total in one round. The total uses the filters
			// without the cursor, so it is the same on every page.
			const [rows, [counted]] = await Promise.all([
				db
					.select({
						...getTableColumns(activityLog),
						...actorColumns,
					})
					.from(activityLog)
					// One query, no per-row lookups. No live(): a removed roster
					// entry or template still names who acted.
					.leftJoin(user, eq(user.id, activityLog.actorUserId))
					.leftJoin(
						rosterEntry,
						eq(rosterEntry.id, activityLog.actorRosterEntryId),
					)
					.leftJoin(
						agentTemplate,
						eq(agentTemplate.id, rosterEntry.agentTemplateId),
					)
					.where(and(filters, after(position, query.cursor)))
					.orderBy(desc(activityLog.at), desc(activityLog.id))
					.limit(query.limit + 1),
				db
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(activityLog)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(
				rows.map((r) => ({ ...r, createdAt: r.at })),
				query.limit,
			);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map(toWire),
					meta: { nextCursor, total: counted?.n ?? 0 },
				},
			};
		},
	});
}
