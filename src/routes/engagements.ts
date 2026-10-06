import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, ne } from "drizzle-orm";
import { type Engagement, engagementContract, ok, page } from "../contract";
import { logActivity } from "../db/activity";
import { client, connection, engagement } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
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

type Row = typeof engagement.$inferSelect;

/** Database row (snake_case columns, Dates) to wire shape (camelCase, ISO strings). */
function toWire(row: Row): Engagement {
	return {
		id: row.id,
		clientId: row.clientId,
		name: row.name,
		scopeMd: row.scopeMd,
		status: row.status,
		startedAt: row.startedAt.toISOString(),
		closedAt: row.closedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export function engagementRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(engagementContract, {
		list: async ({ query }) => {
			const rows = await deps
				.db()
				.select()
				.from(engagement)
				.where(
					and(
						live(engagement),
						query.clientId
							? eq(engagement.clientId, query.clientId)
							: undefined,
						after(engagement, query.cursor),
					),
				)
				.orderBy(desc(engagement.createdAt), desc(engagement.id))
				.limit(query.limit + 1);
			const { items, nextCursor } = toPage(rows, query.limit);
			return { status: 200, body: page(items.map(toWire), nextCursor) };
		},

		get: async ({ params }) => {
			const [row] = await deps
				.db()
				.select()
				.from(engagement)
				.where(and(eq(engagement.id, params.id), live(engagement)));
			if (!row) throw notFound("engagement", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				// Locked for share, so the client cannot be closed or deleted
				// between this check and the insert.
				const [parent] = await tx
					.select({ status: client.status })
					.from(client)
					.where(and(eq(client.id, body.clientId), live(client)))
					.for("share");
				if (!parent) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The client does not exist",
						{
							details: { reason: "client_not_found", clientId: body.clientId },
						},
					);
				}
				if (parent.status !== "active") {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"A closed client cannot take a new engagement",
						{ details: { reason: "client_closed", clientId: body.clientId } },
					);
				}
				const values = {
					id: deps.ids.next(),
					clientId: body.clientId,
					name: body.name,
					scopeMd: body.scopeMd ?? null,
					status: "active" as const,
					startedAt: body.startedAt
						? new Date(body.startedAt)
						: deps.clock.now(),
					closedAt: null,
					deletedAt: null,
					...stamp(deps.clock),
				};
				await tx.insert(engagement).values(values);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "engagement.created",
					entityType: "engagement",
					entityId: values.id,
					engagementId: values.id,
					requestId: ctx.requestId,
					payload: { clientId: values.clientId, name: values.name },
				});
				return values;
			});
			return { status: 201, body: ok(toWire(row)) };
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const [updated] = await tx
					.update(engagement)
					.set({ ...body, ...touch(deps.clock) })
					.where(and(eq(engagement.id, params.id), live(engagement)))
					.returning();
				if (!updated) throw notFound("engagement", params.id);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "engagement.updated",
					entityType: "engagement",
					entityId: params.id,
					engagementId: params.id,
					requestId: ctx.requestId,
					payload: { changes: body },
				});
				return updated;
			});
			return { status: 200, body: ok(toWire(row)) };
		},

		close: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const now = deps.clock.now();
				const [closed] = await tx
					.update(engagement)
					.set({ status: "closed", closedAt: now, updatedAt: now })
					.where(
						and(
							eq(engagement.id, params.id),
							live(engagement),
							eq(engagement.status, "active"),
						),
					)
					.returning();
				if (!closed) {
					const [existing] = await tx
						.select({ id: engagement.id })
						.from(engagement)
						.where(and(eq(engagement.id, params.id), live(engagement)));
					if (!existing) throw notFound("engagement", params.id);
					throw new ApiError("CONFLICT", "The engagement is already closed");
				}
				// Closing revokes the engagement's live credentials, in this same
				// transaction (DATA-CONTRACTS-V2, Engagement and Connection). Already
				// revoked and soft-deleted connections are left as they are.
				const revoked = await tx
					.update(connection)
					.set({ status: "revoked", revokedAt: now, updatedAt: now })
					.where(
						and(
							eq(connection.engagementId, params.id),
							live(connection),
							ne(connection.status, "revoked"),
						),
					)
					.returning({ id: connection.id });
				revoked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
				for (const { id } of revoked) {
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "connection.revoked",
						entityType: "connection",
						entityId: id,
						engagementId: params.id,
						requestId: ctx.requestId,
						payload: { reason: "engagement_closed" },
					});
				}
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "engagement.closed",
					entityType: "engagement",
					entityId: params.id,
					engagementId: params.id,
					requestId: ctx.requestId,
					payload: {
						closedAt: now.toISOString(),
						revokedConnectionIds: revoked.map((r) => r.id),
					},
				});
				return closed;
			});
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
