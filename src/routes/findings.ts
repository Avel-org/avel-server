import { tsr } from "@ts-rest/serverless/fetch";
import { and, count, desc, eq } from "drizzle-orm";
import { type FindingStatus, findingContract, ok } from "../contract";
import { logActivity } from "../db/activity";
import { finding, mission } from "../db/schema";
import { live, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import { toFindingWire } from "./agent";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

/** A live mission's engagement, or 404: findings of a removed mission are not listed. */
async function liveMission(db: Executor | Tx, id: string) {
	const [row] = await db
		.select({ id: mission.id, engagementId: mission.engagementId })
		.from(mission)
		.where(and(eq(mission.id, id), live(mission)));
	if (!row) throw notFound("mission", id);
	return row;
}

/**
 * The operator's triage of judges' findings (module 9). Only an open finding
 * moves, once: confirmed, or dismissed with a reason. The row is locked, so
 * two triage requests on one finding serialize and the second is refused.
 */
export function findingRoutes(deps: RouteDeps) {
	async function triage(
		id: string,
		to: Exclude<FindingStatus, "open">,
		reason: string | null,
		ctx: RequestContext,
	) {
		const operator = operatorOf(ctx);
		return withTx(deps.db(), async (tx) => {
			const [row] = await tx
				.select({ f: finding, engagementId: mission.engagementId })
				.from(finding)
				.innerJoin(
					mission,
					and(eq(mission.id, finding.missionId), live(mission)),
				)
				.where(eq(finding.id, id))
				.for("update", { of: finding });
			if (!row) throw notFound("finding", id);
			if (row.f.status !== "open") {
				throw new ApiError(
					"PRECONDITION_FAILED",
					`The finding is already ${row.f.status}`,
					{ details: { reason: "finding_not_open" } },
				);
			}
			const [updated] = await tx
				.update(finding)
				.set({ status: to, dismissedReason: reason, ...touch(deps.clock) })
				.where(eq(finding.id, id))
				.returning();
			await logActivity(tx, deps, {
				actorKind: "operator",
				actorUserId: operator.id,
				action: to === "confirmed" ? "finding.confirmed" : "finding.dismissed",
				entityType: "finding",
				entityId: id,
				missionId: row.f.missionId,
				engagementId: row.engagementId,
				requestId: ctx.requestId,
				payload:
					reason === null ? { from: "open", to } : { from: "open", to, reason },
			});
			return toFindingWire(updated as typeof finding.$inferSelect);
		});
	}

	return tsr.platformContext<RequestContext>().router(findingContract, {
		list: async ({ params, query }) => {
			const db = deps.db();
			await liveMission(db, params.id);
			const ofMission = eq(finding.missionId, params.id);
			const filters = and(
				ofMission,
				query.status ? eq(finding.status, query.status) : undefined,
			);
			const [rows, [counted], byStatus] = await Promise.all([
				db
					.select()
					.from(finding)
					.where(and(filters, after(finding, query.cursor)))
					.orderBy(desc(finding.createdAt), desc(finding.id))
					.limit(query.limit + 1),
				db.select({ total: count() }).from(finding).where(filters),
				db
					.select({ status: finding.status, n: count() })
					.from(finding)
					.where(ofMission)
					.groupBy(finding.status),
			]);
			const counts = { open: 0, confirmed: 0, dismissed: 0 };
			for (const s of byStatus) counts[s.status] = s.n;
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: {
					success: true,
					data: items.map(toFindingWire),
					meta: { nextCursor, total: counted?.total ?? 0, counts },
				},
			};
		},
		confirm: async ({ params }, ctx) => ({
			status: 200,
			body: ok(await triage(params.id, "confirmed", null, ctx)),
		}),
		dismiss: async ({ params, body }, ctx) => ({
			status: 200,
			body: ok(await triage(params.id, "dismissed", body.reason, ctx)),
		}),
	});
}
