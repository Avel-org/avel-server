import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	desc,
	eq,
	getTableName,
	ilike,
	inArray,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import {
	type CreatePresetBody,
	ok,
	type Preset,
	type PresetAgent,
	type PresetApplication,
	type PresetListQuery,
	page,
	presetContract,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	activityLog,
	agentTemplate,
	mission,
	rosterEntry,
	rosterPreset,
	user,
} from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import type { PresetAgent as StoredAgent } from "../db/schema/work";
import { type Executor, type Tx, withTx } from "../db/tx";
import { type ActorRow, activityActor, actorColumns } from "./activity";
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

/** What applyPreset writes on its roster.preset_applied row. */
const appliedPayload = z.object({
	presetId: z.string().uuid(),
	presetVersion: z.number().int().positive(),
	added: z.array(z.string().uuid()),
	removed: z.array(z.string().uuid()),
});

/**
 * The preset's roster.preset_applied rows. payload->>'presetId' is raw sql,
 * so the column is written table-qualified: unqualified, it would bind to
 * whichever joined table has a "payload" column first.
 *
 * Served by activity_log_preset_applied_idx (drizzle/0046).
 */
function appliedFilter(presetId: string): SQL | undefined {
	const payload = sql`${sql.identifier(getTableName(activityLog))}.${sql.identifier(activityLog.payload.name)}`;
	return and(
		eq(activityLog.action, "roster.preset_applied"),
		sql`${payload}->>'presetId' = ${presetId}`,
	);
}

/** The keyset position shared.ts pages on: (at desc, id desc), as /api/activity. */
const appliedPosition = { createdAt: activityLog.at, id: activityLog.id };

/**
 * The two reads of GET /api/presets/:id/applications: one page, and the
 * total. Exported so tests/db/preset-applications-index.test.ts can EXPLAIN
 * exactly what the route sends.
 */
export function presetApplicationQueries(
	db: Executor,
	presetId: string,
	query: { cursor?: string; limit: number },
) {
	const filters = appliedFilter(presetId);
	return {
		rows: db
			.select({
				at: activityLog.at,
				missionId: activityLog.entityId,
				payload: activityLog.payload,
				...actorColumns,
				missionStatus: mission.status,
				missionType: mission.type,
			})
			.from(activityLog)
			.leftJoin(user, eq(user.id, activityLog.actorUserId))
			.leftJoin(rosterEntry, eq(rosterEntry.id, activityLog.actorRosterEntryId))
			.leftJoin(
				agentTemplate,
				eq(agentTemplate.id, rosterEntry.agentTemplateId),
			)
			// live() in the join, so a deleted mission reads as null.
			.leftJoin(
				mission,
				and(eq(mission.id, activityLog.entityId), live(mission)),
			)
			.where(and(filters, after(appliedPosition, query.cursor)))
			.orderBy(desc(activityLog.at), desc(activityLog.id))
			.limit(query.limit + 1),
		count: db
			.select({ total: sql<number>`count(*)`.mapWith(Number) })
			.from(activityLog)
			.where(filters),
	};
}

type ApplicationRow = ActorRow & {
	at: Date;
	missionId: string;
	payload: unknown;
	missionStatus: NonNullable<PresetApplication["mission"]>["status"] | null;
	missionType: string | null;
};

/** A payload that does not parse is a broken row: a 500, never a guess. */
function toApplication(row: ApplicationRow): PresetApplication {
	const payload = appliedPayload.safeParse(row.payload);
	if (!payload.success) {
		throw new Error(
			`activity ${row.id}: roster.preset_applied payload does not parse`,
		);
	}
	return {
		missionId: row.missionId,
		mission:
			row.missionStatus !== null && row.missionType !== null
				? { status: row.missionStatus, type: row.missionType }
				: null,
		presetVersion: payload.data.presetVersion,
		appliedAt: row.at.toISOString(),
		actor: activityActor(row),
		added: payload.data.added.length,
		removed: payload.data.removed.length,
	};
}

function filtersFor(query: PresetListQuery): SQL | undefined {
	return and(
		live(rosterPreset),
		query.q ? ilike(rosterPreset.name, containsPattern(query.q)) : undefined,
		query.cut ? inArray(rosterPreset.cut, query.cut) : undefined,
	);
}

/** Writes a new preset at version 1, as POST /api/presets or an approved proposal. */
export async function createPreset(
	tx: Tx,
	deps: Pick<RouteDeps, "clock" | "ids">,
	body: CreatePresetBody,
	by: { actorUserId: string; requestId: string },
): Promise<Row> {
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
		actorUserId: by.actorUserId,
		action: "preset.created",
		entityType: "roster_preset",
		entityId: values.id,
		requestId: by.requestId,
		payload: {
			name: values.name,
			cut: values.cut,
			agentCount: values.agents.length,
		},
	});
	return values;
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

		applications: async ({ params, query }) => {
			const db = deps.db();
			const [preset] = await db
				.select({ id: rosterPreset.id })
				.from(rosterPreset)
				.where(and(eq(rosterPreset.id, params.id), live(rosterPreset)));
			if (!preset) throw notFound("preset", params.id);
			const q = presetApplicationQueries(db, params.id, query);
			const [rows, [counted]] = await Promise.all([q.rows, q.count]);
			const { items, nextCursor } = toPage(
				rows.map((r) => ({ ...r, createdAt: r.at })),
				query.limit,
			);
			return {
				status: 200,
				body: page(items.map(toApplication), nextCursor, counted?.total ?? 0),
			};
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), (tx) =>
				createPreset(tx, deps, body, {
					actorUserId: operator.id,
					requestId: ctx.requestId,
				}),
			);
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
