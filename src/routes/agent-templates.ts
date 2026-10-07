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
	type AgentTemplate,
	type AgentTemplateListQuery,
	agentTemplateContract,
	ok,
	page,
} from "../contract";
import { agentTemplate } from "../db/schema";
import { live } from "../db/schema/columns";
import { ApiError } from "../middleware/errors";
import {
	after,
	containsPattern,
	notFound,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof agentTemplate.$inferSelect;

function toWire(row: Row): AgentTemplate {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		kind: row.kind,
		roles: row.roles,
		engagementId: row.engagementId,
		waveDefaults: row.waveDefaults,
		identityMd: row.identityMd,
		depthMd: row.depthMd,
		writablePaths: row.writablePaths,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function filtersFor(query: AgentTemplateListQuery): SQL | undefined {
	const pattern = query.q ? containsPattern(query.q) : undefined;
	return and(
		live(agentTemplate),
		pattern
			? or(
					ilike(agentTemplate.slug, pattern),
					ilike(agentTemplate.name, pattern),
				)
			: undefined,
		query.kind ? inArray(agentTemplate.kind, query.kind) : undefined,
		query.role ? arrayOverlaps(agentTemplate.roles, query.role) : undefined,
		query.wave
			? arrayOverlaps(agentTemplate.waveDefaults, query.wave)
			: undefined,
		query.engagementId
			? eq(agentTemplate.engagementId, query.engagementId)
			: undefined,
	);
}

export function agentTemplateRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(agentTemplateContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(agentTemplate)
					.where(and(filters, after(agentTemplate, query.cursor)))
					.orderBy(desc(agentTemplate.createdAt), desc(agentTemplate.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(agentTemplate)
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
				.select()
				.from(agentTemplate)
				.where(and(eq(agentTemplate.id, params.id), live(agentTemplate)));
			if (!row) throw notFound("agent template", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		// The slug is unique among live templates (agent_template_slug_live_uq).
		getBySlug: async ({ params }) => {
			const [row] = await deps
				.db()
				.select()
				.from(agentTemplate)
				.where(and(eq(agentTemplate.slug, params.slug), live(agentTemplate)));
			if (!row) {
				throw new ApiError(
					"NOT_FOUND",
					`No agent template with slug ${params.slug}`,
				);
			}
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
