import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	type Column,
	desc,
	eq,
	getTableName,
	ilike,
	or,
	type SQL,
	sql,
	type Table,
} from "drizzle-orm";
import { type Client, clientContract, ok, page } from "../contract";
import { logActivity, touchesClient } from "../db/activity";
import { client, engagement } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { type Executor, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	after,
	containsPattern,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

/**
 * Drizzle renders a column inside a select-list sql`` unqualified, and in a
 * correlated subquery "id" then binds to the inner table. Every column the
 * subquery touches is written table-qualified instead.
 */
function q(table: Table, column: Column): SQL {
	return sql`${sql.identifier(getTableName(table))}.${sql.identifier(column.name)}`;
}

const engagementIsLive = sql`${q(engagement, engagement.deletedAt)} is null`;

/**
 * The client columns plus the two engagement counts, over live engagements
 * only. The subqueries cannot use live(), which renders unqualified; they
 * apply the same deleted_at test, qualified.
 */
const withCounts = {
	id: client.id,
	name: client.name,
	status: client.status,
	primaryContact: client.primaryContact,
	notesMd: client.notesMd,
	createdAt: client.createdAt,
	updatedAt: client.updatedAt,
	engagementCount: sql<number>`(
		select count(*) from ${engagement}
		where ${q(engagement, engagement.clientId)} = ${q(client, client.id)}
			and ${engagementIsLive}
	)`.mapWith(Number),
	activeEngagementCount: sql<number>`(
		select count(*) from ${engagement}
		where ${q(engagement, engagement.clientId)} = ${q(client, client.id)}
			and ${engagementIsLive}
			and ${q(engagement, engagement.status)} = 'active'
	)`.mapWith(Number),
	lastActivityAt: sql<string | null>`(
		select max("activity_log"."at") from "activity_log"
		where ${touchesClient(q(client, client.id))}
	)`,
};

type Row = {
	id: string;
	name: string;
	status: Client["status"];
	primaryContact: string | null;
	notesMd: string | null;
	createdAt: Date;
	updatedAt: Date;
	engagementCount: number;
	activeEngagementCount: number;
	lastActivityAt: string | Date | null;
};

/** Database row (snake_case columns, Dates) to wire shape (camelCase, ISO strings). */
function toWire(row: Row): Client {
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		primaryContact: row.primaryContact,
		notesMd: row.notesMd,
		engagementCount: row.engagementCount,
		activeEngagementCount: row.activeEngagementCount,
		lastActivityAt:
			row.lastActivityAt === null
				? null
				: new Date(row.lastActivityAt).toISOString(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function findLive(db: Executor, id: string): Promise<Row | undefined> {
	const [row] = await db
		.select(withCounts)
		.from(client)
		.where(and(eq(client.id, id), live(client)));
	return row;
}

export function clientRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(clientContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const pattern = query.q ? containsPattern(query.q) : undefined;
			const filters = and(
				live(client),
				query.status ? eq(client.status, query.status) : undefined,
				pattern
					? or(
							ilike(client.name, pattern),
							ilike(client.primaryContact, pattern),
						)
					: undefined,
			);
			// The page and the total in one round. The total uses the list's
			// filters without the cursor, so it is the same on every page.
			const [rows, [counted]] = await Promise.all([
				db
					.select(withCounts)
					.from(client)
					.where(and(filters, after(client, query.cursor)))
					.orderBy(desc(client.createdAt), desc(client.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(client)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(items.map(toWire), nextCursor, counted?.total ?? 0),
			};
		},

		get: async ({ params }) => {
			const row = await findLive(deps.db(), params.id);
			if (!row) throw notFound("client", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const values = {
					id: deps.ids.next(),
					name: body.name,
					status: "active" as const,
					primaryContact: body.primaryContact ?? null,
					notesMd: body.notesMd ?? null,
					...stamp(deps.clock),
				};
				await tx.insert(client).values(values);
				const log = await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "client.created",
					entityType: "client",
					entityId: values.id,
					requestId: ctx.requestId,
					payload: { name: values.name },
				});
				return {
					...values,
					engagementCount: 0,
					activeEngagementCount: 0,
					lastActivityAt: log.at,
				};
			});
			return { status: 201, body: ok(toWire(row)) };
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				if (body.status === "closed") {
					// Locked FOR UPDATE: engagement create holds FOR SHARE on this row
					// while it checks the client, so no engagement can be created
					// between this check and the close. Nothing closes implicitly.
					const [locked] = await tx
						.select({ id: client.id })
						.from(client)
						.where(and(eq(client.id, params.id), live(client)))
						.for("update");
					if (!locked) throw notFound("client", params.id);
					const [active] = await tx
						.select({ id: engagement.id })
						.from(engagement)
						.where(
							and(
								eq(engagement.clientId, params.id),
								live(engagement),
								eq(engagement.status, "active"),
							),
						)
						.limit(1);
					if (active) {
						throw new ApiError(
							"PRECONDITION_FAILED",
							"Close the client's active engagements first",
							{ details: { reason: "client_has_active_engagements" } },
						);
					}
				}
				const [updated] = await tx
					.update(client)
					.set({ ...body, ...touch(deps.clock) })
					.where(and(eq(client.id, params.id), live(client)))
					.returning({ id: client.id });
				if (!updated) throw notFound("client", params.id);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "client.updated",
					entityType: "client",
					entityId: params.id,
					requestId: ctx.requestId,
					payload: { changes: body },
				});
				return findLive(tx, params.id);
			});
			if (!row) throw notFound("client", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
