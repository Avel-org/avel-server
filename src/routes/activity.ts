import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { type ActivityEntry, activityContract } from "../contract";
import { activityLog, agentTemplate, rosterEntry, user } from "../db/schema";
import { after, type RequestContext, type RouteDeps, toPage } from "./shared";

type Row = typeof activityLog.$inferSelect & {
	login: string | null;
	agentName: string | null;
	territory: string | null;
};

/**
 * The columns actorDisplay reads. Select them with activity_log left-joined
 * to user on actor_user_id, roster_entry on actor_roster_entry_id, and
 * agent_template on the entry's template, with no live(): a removed entry
 * or template still names who acted.
 */
export const actorColumns = {
	login: user.githubLogin,
	agentName: agentTemplate.name,
	territory: rosterEntry.territory,
};

type ActorRow = Pick<
	Row,
	"id" | "actorKind" | "login" | "agentName" | "territory"
>;

/**
 * The actor's label. The CHECKs on activity_log tie each kind to its foreign
 * key, and the foreign keys keep the joined rows, so a missing name is a
 * broken row: a 500, never a made-up label.
 */
export function actorDisplay(row: ActorRow): string {
	switch (row.actorKind) {
		case "system":
			return "System";
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
		actor: { kind: row.actorKind, display: actorDisplay(row) },
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
				query.entityId ? eq(activityLog.entityId, query.entityId) : undefined,
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
