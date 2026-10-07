import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Connection, connectionContract, ok } from "../contract";
import { logActivity } from "../db/activity";
import { client, connection, engagement } from "../db/schema";
import { live, stamp } from "../db/schema/columns";
import { withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof connection.$inferSelect;

/**
 * Database row to wire shape. credential_ref is the name of an env var, so
 * it is safe to return; the token it names is never read here.
 */
function toWire(row: Row): Connection {
	return {
		id: row.id,
		service: row.service,
		engagementId: row.engagementId,
		label: row.label,
		scopeType: row.scopeType,
		scopeValue: row.scopeValue,
		credentialRef: row.credentialRef,
		status: row.status,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		lastRotatedAt: row.lastRotatedAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Operator-only, minimal: list, get, create (decided 2026-10-06). Revoke,
 * rotate and the rest arrive with module 11. Revocation already happens when
 * an engagement closes (src/routes/engagements.ts).
 */
export function connectionRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(connectionContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = and(
				live(connection),
				query.engagementId
					? eq(connection.engagementId, query.engagementId)
					: undefined,
				query.status ? eq(connection.status, query.status) : undefined,
			);
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(connection)
					.where(and(filters, after(connection, query.cursor)))
					.orderBy(desc(connection.createdAt), desc(connection.id))
					.limit(query.limit + 1),
				db
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(connection)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map(toWire),
					meta: { nextCursor, total: counted?.n ?? 0 },
				},
			};
		},

		get: async ({ params }) => {
			const [row] = await deps
				.db()
				.select()
				.from(connection)
				.where(and(eq(connection.id, params.id), live(connection)));
			if (!row) throw notFound("connection", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				if (body.engagementId !== null) {
					// Locked for share, so the engagement cannot close between
					// this check and the insert.
					const [parent] = await tx
						.select({ status: engagement.status })
						.from(engagement)
						.innerJoin(
							client,
							and(eq(client.id, engagement.clientId), live(client)),
						)
						.where(and(eq(engagement.id, body.engagementId), live(engagement)))
						.for("share", { of: engagement });
					if (!parent) {
						throw new ApiError(
							"PRECONDITION_FAILED",
							"The engagement does not exist",
							{
								details: {
									reason: "engagement_not_found",
									engagementId: body.engagementId,
								},
							},
						);
					}
					if (parent.status !== "active") {
						throw new ApiError(
							"PRECONDITION_FAILED",
							"A closed engagement cannot take a new connection",
							{
								details: {
									reason: "engagement_closed",
									engagementId: body.engagementId,
								},
							},
						);
					}
				}
				const values = {
					id: deps.ids.next(),
					service: "github" as const,
					engagementId: body.engagementId,
					label: body.label,
					scopeType: body.scopeType,
					scopeValue: body.scopeValue,
					credentialRef: body.credentialRef,
					status: "active" as const,
					expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
					lastRotatedAt: null,
					revokedAt: null,
					deletedAt: null,
					...stamp(deps.clock),
				};
				const [inserted] = await tx
					.insert(connection)
					.values(values)
					.returning();
				if (!inserted) throw new Error("connection insert returned no row");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "connection.created",
					entityType: "connection",
					entityId: values.id,
					engagementId: values.engagementId,
					requestId: ctx.requestId,
					// The credential's name only: never a value, which this route never sees.
					payload: {
						scopeType: values.scopeType,
						scopeValue: values.scopeValue,
						credentialRef: values.credentialRef,
					},
				});
				return inserted;
			});
			return { status: 201, body: ok(toWire(row)) };
		},
	});
}
