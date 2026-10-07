import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	arrayOverlaps,
	desc,
	eq,
	ilike,
	inArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	ok,
	page,
	type Skill,
	type SkillListItem,
	type SkillListQuery,
	skillContract,
} from "../contract";
import { skill, skillSource } from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	after,
	containsPattern,
	notFound,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

/** Everything a list item carries. The text columns are left out of list reads. */
const listColumns = {
	id: skill.id,
	slug: skill.slug,
	name: skill.name,
	description: skill.description,
	layer: skill.layer,
	type: skill.type,
	grants: skill.grants,
	ioShape: skill.ioShape,
	recommendedFor: skill.recommendedFor,
	sourceId: skillSource.id,
	sourceName: skillSource.name,
	sourceKind: skillSource.kind,
	contentSha256: skill.contentSha256,
	status: skill.status,
	reviewedBy: skill.reviewedBy,
	reviewedAt: skill.reviewedAt,
	version: skill.version,
	createdAt: skill.createdAt,
	updatedAt: skill.updatedAt,
};

const fullColumns = {
	...listColumns,
	contentMd: skill.contentMd,
	avelEnhancementMd: skill.avelEnhancementMd,
};

type SkillRow = typeof skill.$inferSelect;
type SourceRow = typeof skillSource.$inferSelect;

type ListRow = Pick<
	SkillRow,
	| "id"
	| "slug"
	| "name"
	| "description"
	| "layer"
	| "type"
	| "grants"
	| "ioShape"
	| "recommendedFor"
	| "contentSha256"
	| "status"
	| "reviewedBy"
	| "reviewedAt"
	| "version"
	| "createdAt"
	| "updatedAt"
> & {
	sourceId: SourceRow["id"];
	sourceName: SourceRow["name"];
	sourceKind: SourceRow["kind"];
};
type FullRow = ListRow & Pick<SkillRow, "contentMd" | "avelEnhancementMd">;

/**
 * The skill_capability_fields CHECK guarantees a capability has grants and
 * ioShape and a knowledge skill has neither. A row that breaks it is a
 * server bug, so it is a 500, never a shape the contract does not describe.
 */
function variant(row: ListRow) {
	if (row.type === "knowledge") {
		return { type: "knowledge" as const, grants: null, ioShape: null };
	}
	if (!row.grants || !row.ioShape) {
		throw new Error(
			`skill ${row.id} is a capability without grants or ioShape`,
		);
	}
	return {
		type: "capability" as const,
		grants: row.grants,
		ioShape: row.ioShape,
	};
}

function toListItem(row: ListRow): SkillListItem {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		layer: row.layer,
		...variant(row),
		recommendedFor: row.recommendedFor,
		source: { id: row.sourceId, name: row.sourceName, kind: row.sourceKind },
		contentSha256: row.contentSha256,
		status: row.status,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function toWire(row: FullRow): Skill {
	return {
		...toListItem(row),
		contentMd: row.contentMd,
		avelEnhancementMd: row.avelEnhancementMd,
	};
}

function filtersFor(query: SkillListQuery): SQL | undefined {
	const pattern = query.q ? containsPattern(query.q) : undefined;
	return and(
		live(skill),
		pattern
			? or(
					ilike(skill.slug, pattern),
					ilike(skill.name, pattern),
					ilike(skill.description, pattern),
				)
			: undefined,
		query.layer ? inArray(skill.layer, query.layer) : undefined,
		query.type ? eq(skill.type, query.type) : undefined,
		query.status ? inArray(skill.status, query.status) : undefined,
		query.role ? arrayOverlaps(skill.recommendedFor, query.role) : undefined,
		query.sourceId ? eq(skill.sourceId, query.sourceId) : undefined,
	);
}

/** One live skill with its text, or undefined. */
async function findLive(
	db: Executor,
	where: SQL | undefined,
): Promise<FullRow | undefined> {
	const [row] = await db
		.select(fullColumns)
		.from(skill)
		.innerJoin(skillSource, eq(skillSource.id, skill.sourceId))
		.where(and(where, live(skill)));
	return row;
}

export function skillRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(skillContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select(listColumns)
					.from(skill)
					.innerJoin(skillSource, eq(skillSource.id, skill.sourceId))
					.where(and(filters, after(skill, query.cursor)))
					.orderBy(desc(skill.createdAt), desc(skill.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(skill)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(items.map(toListItem), nextCursor, counted?.total ?? 0),
			};
		},

		get: async ({ params }) => {
			const row = await findLive(deps.db(), eq(skill.id, params.id));
			if (!row) throw notFound("skill", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		// The slug is unique among live skills (skill_slug_live_uq).
		getBySlug: async ({ params }) => {
			const row = await findLive(deps.db(), eq(skill.slug, params.slug));
			if (!row) {
				throw new ApiError("NOT_FOUND", `No skill with slug ${params.slug}`);
			}
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
