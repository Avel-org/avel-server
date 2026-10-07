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
import { skill, skillSource } from "../db/schema";
import { live } from "../db/schema/columns";
import {
	after,
	containsPattern,
	notFound,
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
			const [row] = await deps
				.db()
				.select(withCount)
				.from(skillSource)
				.where(and(eq(skillSource.id, params.id), live(skillSource)));
			if (!row) throw notFound("skill source", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
