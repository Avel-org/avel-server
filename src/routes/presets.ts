import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, ilike, inArray, type SQL, sql } from "drizzle-orm";
import {
	ok,
	type Preset,
	type PresetAgent,
	type PresetListQuery,
	page,
	presetContract,
} from "../contract";
import { logActivity } from "../db/activity";
import { rosterPreset } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import type { PresetAgent as StoredAgent } from "../db/schema/work";
import { withTx } from "../db/tx";
import { requirePresetAgents } from "./roster";
import {
	after,
	containsPattern,
	notFound,
	operatorOf,
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

/** The wire's nulls become absent keys, the stored shape. */
function toStored(agents: PresetAgent[]): StoredAgent[] {
	return agents.map((a) => ({
		agent_template_id: a.agentTemplateId,
		waves: a.waves,
		...(a.territory !== null ? { territory: a.territory } : {}),
		...(a.writablePaths !== null ? { writable_paths: a.writablePaths } : {}),
		...(a.estimatedTokens !== null
			? { estimated_tokens: a.estimatedTokens }
			: {}),
	}));
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

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				await requirePresetAgents(tx, body.agents);
				const values = {
					id: deps.ids.next(),
					name: body.name,
					description: body.description ?? null,
					cut: body.cut,
					agents: toStored(body.agents),
					version: 1,
					deletedAt: null,
					...stamp(deps.clock),
				};
				await tx.insert(rosterPreset).values(values);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "preset.created",
					entityType: "roster_preset",
					entityId: values.id,
					requestId: ctx.requestId,
					payload: {
						name: values.name,
						cut: values.cut,
						agentCount: values.agents.length,
					},
				});
				return values;
			});
			return { status: 201, body: ok(toWire(row)) };
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				// Locked FOR UPDATE, so concurrent updates bump the version one at a time.
				const [current] = await tx
					.select({ version: rosterPreset.version })
					.from(rosterPreset)
					.where(and(eq(rosterPreset.id, params.id), live(rosterPreset)))
					.for("update");
				if (!current) throw notFound("preset", params.id);
				if (body.agents) await requirePresetAgents(tx, body.agents);
				const { agents, ...rest } = body;
				const [updated] = await tx
					.update(rosterPreset)
					.set({
						...rest,
						...(agents ? { agents: toStored(agents) } : {}),
						version: current.version + 1,
						...touch(deps.clock),
					})
					.where(eq(rosterPreset.id, params.id))
					.returning();
				if (!updated) throw new Error("a locked preset was not updatable");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "preset.updated",
					entityType: "roster_preset",
					entityId: params.id,
					requestId: ctx.requestId,
					// Field names only, like the roster: agents can be long.
					payload: {
						fields: Object.keys(body).sort(),
						version: updated.version,
					},
				});
				return updated;
			});
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
