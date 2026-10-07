import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	type Column,
	desc,
	eq,
	getTableName,
	ilike,
	inArray,
	type SQL,
	sql,
	type Table,
} from "drizzle-orm";
import {
	ok,
	page,
	type SkillSource,
	type SkillSourceListQuery,
	skillSourceContract,
} from "../contract";
import { logActivity } from "../db/activity";
import { skill, skillSource } from "../db/schema";
import { live, remove, stamp, touch } from "../db/schema/columns";
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

/** The source columns plus its live skill count. live() cannot be used inside the subquery. */
const withCount = {
	id: skillSource.id,
	name: skillSource.name,
	kind: skillSource.kind,
	url: skillSource.url,
	license: skillSource.license,
	createdAt: skillSource.createdAt,
	updatedAt: skillSource.updatedAt,
	skillCount: sql<number>`(
		select count(*) from ${skill}
		where ${q(skill, skill.sourceId)} = ${q(skillSource, skillSource.id)}
			and ${q(skill, skill.deletedAt)} is null
	)`.mapWith(Number),
};

type Row = {
	id: string;
	name: string;
	kind: SkillSource["kind"];
	url: string | null;
	license: string | null;
	createdAt: Date;
	updatedAt: Date;
	skillCount: number;
};

function toWire(row: Row): SkillSource {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		url: row.url,
		license: row.license,
		skillCount: row.skillCount,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function findLive(db: Executor, id: string): Promise<Row | undefined> {
	const [row] = await db
		.select(withCount)
		.from(skillSource)
		.where(and(eq(skillSource.id, id), live(skillSource)));
	return row;
}

function filtersFor(query: SkillSourceListQuery): SQL | undefined {
	return and(
		live(skillSource),
		query.q ? ilike(skillSource.name, containsPattern(query.q)) : undefined,
		query.kind ? inArray(skillSource.kind, query.kind) : undefined,
	);
}

export function skillSourceRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(skillSourceContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select(withCount)
					.from(skillSource)
					.where(and(filters, after(skillSource, query.cursor)))
					.orderBy(desc(skillSource.createdAt), desc(skillSource.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(skillSource)
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
			if (!row) throw notFound("skill source", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const values = {
					id: deps.ids.next(),
					name: body.name,
					kind: body.kind,
					url: body.url ?? null,
					license: body.license ?? null,
					...stamp(deps.clock),
				};
				await tx.insert(skillSource).values(values);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "skill_source.created",
					entityType: "skill_source",
					entityId: values.id,
					requestId: ctx.requestId,
					payload: { name: values.name, kind: values.kind },
				});
				return { ...values, skillCount: 0 };
			});
			return { status: 201, body: ok(toWire(row)) };
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const [updated] = await tx
					.update(skillSource)
					.set({ ...body, ...touch(deps.clock) })
					.where(and(eq(skillSource.id, params.id), live(skillSource)))
					.returning({ id: skillSource.id });
				if (!updated) throw notFound("skill source", params.id);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "skill_source.updated",
					entityType: "skill_source",
					entityId: params.id,
					requestId: ctx.requestId,
					payload: { changes: body },
				});
				return findLive(tx, params.id);
			});
			if (!row) throw notFound("skill source", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		remove: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			await withTx(deps.db(), async (tx) => {
				// Locked FOR UPDATE: skill create and update hold FOR SHARE on the
				// source they name, so no skill can start pointing at it between
				// this check and the delete.
				const [locked] = await tx
					.select({ id: skillSource.id })
					.from(skillSource)
					.where(and(eq(skillSource.id, params.id), live(skillSource)))
					.for("update");
				if (!locked) throw notFound("skill source", params.id);
				const [inUse] = await tx
					.select({ id: skill.id })
					.from(skill)
					.where(and(eq(skill.sourceId, params.id), live(skill)))
					.limit(1);
				if (inUse) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"Skills still come from this source",
						{ details: { reason: "skill_source_in_use" } },
					);
				}
				await tx
					.update(skillSource)
					.set(remove(deps.clock))
					.where(eq(skillSource.id, params.id));
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "skill_source.deleted",
					entityType: "skill_source",
					entityId: params.id,
					requestId: ctx.requestId,
					payload: {},
				});
			});
			return { status: 200, body: ok({ id: params.id }) };
		},
	});
}
