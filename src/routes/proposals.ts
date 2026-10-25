import { tsr } from "@ts-rest/serverless/fetch";
import { and, count, desc, eq } from "drizzle-orm";
import { ok, type Proposal, proposalContract } from "../contract";
import { logActivity } from "../db/activity";
import { proposal } from "../db/schema";
import { touch } from "../db/schema/columns";
import { type Tx, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof proposal.$inferSelect;

function toWire(row: Row): Proposal {
	return {
		id: row.id,
		kind: row.kind,
		source: row.source,
		engagementId: row.engagementId,
		missionId: row.missionId,
		summary: row.summary,
		payload: row.payload,
		premise: row.premise,
		status: row.status,
		reason: row.reason,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The proposal, locked, if it is pending; refused otherwise. */
async function pending(tx: Tx, id: string): Promise<Row> {
	const [row] = await tx
		.select()
		.from(proposal)
		.where(eq(proposal.id, id))
		.for("update");
	if (!row) throw notFound("proposal", id);
	if (row.status !== "pending") {
		throw new ApiError(
			"PRECONDITION_FAILED",
			`The proposal is already ${row.status}`,
			{ details: { reason: "proposal_not_pending" } },
		);
	}
	return row;
}

/**
 * The proposal queue (module 14; J, 2026-10-24). Nothing writes proposals
 * yet, so the queue is empty until a source is built. Deciding locks the
 * row, so two decisions on one proposal serialize and the second refuses.
 */
export function proposalRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(proposalContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = query.status
				? eq(proposal.status, query.status)
				: undefined;
			const [rows, byStatus] = await Promise.all([
				db
					.select()
					.from(proposal)
					.where(and(filters, after(proposal, query.cursor)))
					.orderBy(desc(proposal.createdAt), desc(proposal.id))
					.limit(query.limit + 1),
				db
					.select({ status: proposal.status, n: count() })
					.from(proposal)
					.groupBy(proposal.status),
			]);
			const counts = { pending: 0, approved: 0, dismissed: 0, expired: 0 };
			for (const s of byStatus) counts[s.status] = s.n;
			const total = query.status
				? counts[query.status]
				: counts.pending + counts.approved + counts.dismissed + counts.expired;
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map(toWire),
					meta: { nextCursor, total, counts },
				},
			};
		},

		approve: async ({ params }, ctx) => {
			operatorOf(ctx);
			return withTx(deps.db(), async (tx) => {
				const found = await pending(tx, params.id);
				// Approval starts the kind's action through the normal path
				// (DATA-CONTRACTS-V2.md, Proposal). None is built, so none is approved.
				throw new ApiError(
					"PRECONDITION_FAILED",
					`Approving a ${found.kind} proposal is not built yet`,
					{ details: { reason: "proposal_action_not_built" } },
				);
			});
		},

		dismiss: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const found = await pending(tx, params.id);
				const [updated] = await tx
					.update(proposal)
					.set({
						status: "dismissed",
						reason: body.reason,
						decidedBy: operator.id,
						decidedAt: deps.clock.now(),
						...touch(deps.clock),
					})
					.where(eq(proposal.id, found.id))
					.returning();
				if (!updated) throw new Error("proposal update returned no row");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "proposal.dismissed",
					entityType: "proposal",
					entityId: found.id,
					missionId: found.missionId,
					engagementId: found.engagementId,
					requestId: ctx.requestId,
					payload: { kind: found.kind, reason: body.reason },
				});
				return updated;
			});
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
