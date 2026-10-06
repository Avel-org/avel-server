import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, sql } from "drizzle-orm";
import { type ActivityEntry, activityContract } from "../contract";
import { activityLog } from "../db/schema";
import { after, type RequestContext, type RouteDeps, toPage } from "./shared";

type Row = typeof activityLog.$inferSelect;

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
					.select()
					.from(activityLog)
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
