import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, ilike, inArray, type SQL, sql } from "drizzle-orm";
import {
	ok,
	type Preset,
	type PresetListQuery,
	page,
	presetContract,
} from "../contract";
import { rosterPreset } from "../db/schema";
import { live } from "../db/schema/columns";
import {
	after,
	containsPattern,
	notFound,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof rosterPreset.$inferSelect;

/** The agents column is snake_case jsonb with optional keys; the wire is camelCase with nulls. */
function toWire(row: Row): Preset {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		cut: row.cut,
		agents: row.agents.map((a) => ({
			agentTemplateId: a.agent_template_id,
			waves: a.waves,
			territory: a.territory ?? null,
			writablePaths: a.writable_paths ?? null,
			estimatedTokens: a.estimated_tokens ?? null,
		})),
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function filtersFor(query: PresetListQuery): SQL | undefined {
	return and(
		live(rosterPreset),
		query.q ? ilike(rosterPreset.name, containsPattern(query.q)) : undefined,
		query.cut ? inArray(rosterPreset.cut, query.cut) : undefined,
	);
}

export function presetRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(presetContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(rosterPreset)
					.where(and(filters, after(rosterPreset, query.cursor)))
					.orderBy(desc(rosterPreset.createdAt), desc(rosterPreset.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(rosterPreset)
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
				.from(rosterPreset)
				.where(and(eq(rosterPreset.id, params.id), live(rosterPreset)));
			if (!row) throw notFound("preset", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
