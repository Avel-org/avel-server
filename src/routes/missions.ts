import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	desc,
	eq,
	ilike,
	inArray,
	isNotNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import {
	MISSION_STATUSES,
	type MissionDetail,
	type MissionListItem,
	type MissionStatus,
	missionContract,
	ok,
} from "../contract";
import { logActivity } from "../db/activity";
import { missionSpentUsd } from "../db/dispatch";
import {
	activityLog,
	agentTemplate,
	client,
	engagement,
	exportTable,
	gateJob,
	mission,
	playbook,
	rosterEntry,
	user,
} from "../db/schema";
import { live, touch } from "../db/schema/columns";
import { type Executor, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import { activityActor, actorColumns } from "./activity";
import { jobsAhead, toJob } from "./gate";
import {
	containsPattern,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
} from "./shared";

type Sort = "lastActivity" | "sprint" | "client";
type Origin = "internal" | "client";

/** The newest export per mission. Exports are never deleted, so no live() here. */
function lastExports(db: Executor, missionId?: string) {
	return db
		.selectDistinctOn([exportTable.missionId], {
			missionId: exportTable.missionId,
			id: exportTable.id,
			status: exportTable.status,
			targetKind: exportTable.targetKind,
			createdAt: exportTable.createdAt,
			statusChangedAt: exportTable.statusChangedAt,
		})
		.from(exportTable)
		.where(missionId ? eq(exportTable.missionId, missionId) : undefined)
		.orderBy(
			exportTable.missionId,
			desc(exportTable.createdAt),
			desc(exportTable.id),
		)
		.as("last_export");
}

/** One aggregate over ActivityLog: the newest row's time per mission. */
function lastActivity(db: Executor, missionId?: string) {
	return db
		.select({
			missionId: activityLog.missionId,
			at: sql<Date>`max(${activityLog.at})`.as("last_activity_at"),
		})
		.from(activityLog)
		.where(
			missionId
				? eq(activityLog.missionId, missionId)
				: isNotNull(activityLog.missionId),
		)
		.groupBy(activityLog.missionId)
		.as("mission_activity");
}

/**
 * The joins every mission query shares. A client mission is listed only
 * while its engagement and client are live; an internal one has neither.
 */
function base(db: Executor, missionId?: string) {
	const lx = lastExports(db, missionId);
	const la = lastActivity(db, missionId);
	const needsYou = sql<
		"export_previewed" | "pr_open" | null
	>`case ${lx.status} when 'previewed' then 'export_previewed' when 'pr-open' then 'pr_open' end`;
	return { lx, la, needsYou };
}

function scope(query: {
	origin: Origin;
	includeArchived: boolean;
	q?: string;
	clientId?: string;
	templateRef?: string;
}) {
	const { origin, includeArchived, q } = query;
	const pattern = q ? containsPattern(q) : undefined;
	return and(
		live(mission),
		eq(mission.origin, origin),
		origin === "client"
			? and(isNotNull(engagement.id), isNotNull(client.id))
			: undefined,
		includeArchived ? undefined : ne(mission.status, "archived"),
		pattern
			? or(
					ilike(client.name, pattern),
					ilike(engagement.name, pattern),
					ilike(mission.type, pattern),
				)
			: undefined,
		query.clientId ? eq(client.id, query.clientId) : undefined,
		query.templateRef ? eq(mission.templateRef, query.templateRef) : undefined,
	);
}

/** What each sort's cursor carries as its key value. */
const cursorValue = {
	lastActivity: z.string().datetime().nullable(),
	sprint: z.number().int(),
	client: z.string().nullable(),
} satisfies Record<Sort, z.ZodTypeAny>;

type Direction = "asc" | "desc";

/** The sort key for each sort, its default direction, and how a cursor value binds. */
function sortKey(sort: Sort, lastActivityAt: SQL.Aliased<Date>) {
	switch (sort) {
		case "lastActivity":
			return {
				expr: sql`${lastActivityAt}`,
				defaultDir: "desc" as Direction,
				param: (v: string | number | null) =>
					v === null ? null : sql`${String(v)}::timestamptz`,
			};
		case "sprint":
			return {
				expr: sql`${mission.sprintN}`,
				defaultDir: "desc" as Direction,
				param: (v: string | number | null) => sql`${v}::int`,
			};
		case "client":
			// Byte order of the lowercased name: no locale can reorder it.
			return {
				expr: sql`lower(${client.name}) collate "C"`,
				defaultDir: "asc" as Direction,
				param: (v: string | number | null) =>
					v === null ? null : sql`${v}::text collate "C"`,
			};
	}
}

/**
 * The ORDER BY for a sort and direction. A null key is the lowest value:
 * last when descending, first when ascending. The id breaks ties in the
 * same direction.
 */
function orderFor(key: ReturnType<typeof sortKey>, dir: Direction) {
	return dir === "desc"
		? [sql`${key.expr} desc nulls last`, desc(mission.id)]
		: [sql`${key.expr} asc nulls first`, mission.id];
}

type Cursor = { tag: string; value: string | number | null; id: string };

/**
 * A cursor names the sort and direction that issued it. The default
 * direction's tag is the bare sort name, so cursors issued before
 * `direction` existed stay valid.
 */
function cursorTag(sort: Sort, dir: Direction, defaultDir: Direction): string {
	return dir === defaultDir ? sort : `${sort}:${dir}`;
}

function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify([c.tag, c.value, c.id])).toString(
		"base64url",
	);
}

function badCursor(message: string): ApiError {
	return new ApiError("VALIDATION_FAILED", message, {
		details: { query: [{ path: ["cursor"], message }] },
	});
}

/** A cursor is bound to the sort and direction that issued it; any other is refused. */
function decodeCursor(raw: string, sort: Sort, tag: string): Cursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw badCursor("The cursor is not one this server issued");
	}
	const shape = z.tuple([
		z.string(),
		z.union([z.string(), z.number(), z.null()]),
		z.string().uuid(),
	]);
	const result = shape.safeParse(parsed);
	if (!result.success)
		throw badCursor("The cursor is not one this server issued");
	const [cursorTagValue, value, id] = result.data;
	if (cursorTagValue !== tag) {
		throw badCursor(`The cursor belongs to ${cursorTagValue}, not ${tag}`);
	}
	if (!cursorValue[sort].safeParse(value).success) {
		throw badCursor("The cursor is not one this server issued");
	}
	return { tag, value, id };
}

/**
 * Rows after the cursor in orderFor's order. Descending, nulls come last: after
 * a value come smaller values and then every null; after a null, only nulls
 * with a smaller id. Ascending, nulls come first: after a null come nulls with
 * a larger id and then every value; after a value, only larger values.
 */
function after(
	key: ReturnType<typeof sortKey>,
	dir: Direction,
	cursor: Cursor,
): SQL {
	const cv = key.param(cursor.value);
	if (dir === "desc") {
		if (cv === null) {
			return sql`(${key.expr} is null and ${mission.id} < ${cursor.id})`;
		}
		return sql`((${key.expr} is not null and (${key.expr} < ${cv} or (${key.expr} = ${cv} and ${mission.id} < ${cursor.id}))) or ${key.expr} is null)`;
	}
	if (cv === null) {
		return sql`((${key.expr} is null and ${mission.id} > ${cursor.id}) or ${key.expr} is not null)`;
	}
	return sql`(${key.expr} is not null and (${key.expr} > ${cv} or (${key.expr} = ${cv} and ${mission.id} > ${cursor.id})))`;
}

function iso(d: Date | string | null): string | null {
	if (d === null) return null;
	return (d instanceof Date ? d : new Date(d)).toISOString();
}

type ListRow = {
	id: string;
	origin: Origin;
	type: string;
	sprintN: number;
	status: MissionStatus;
	cut: "horizontal" | "vertical";
	cutSource: "derived" | "overridden";
	clientId: string | null;
	clientName: string | null;
	engagementId: string | null;
	engagementName: string | null;
	exportId: string | null;
	exportStatus: MissionListItem["lastExport"] extends infer E
		? E extends { status: infer S }
			? S | null
			: never
		: never;
	exportTargetKind: "zip" | "github_pr" | "github_push" | null;
	exportCreatedAt: Date | null;
	exportStatusChangedAt: Date | null;
	lastActivityAt: Date | string | null;
	needsYou: "export_previewed" | "pr_open" | null;
	gateRunning: boolean;
	clientSortKey: string | null;
	createdAt: Date;
	updatedAt: Date;
};

function toItem(row: ListRow): MissionListItem {
	return {
		id: row.id,
		origin: row.origin,
		type: row.type,
		sprintN: row.sprintN,
		status: row.status,
		cut: row.cut,
		cutSource: row.cutSource,
		client:
			row.clientId && row.clientName
				? { id: row.clientId, name: row.clientName }
				: null,
		engagement:
			row.engagementId && row.engagementName
				? { id: row.engagementId, name: row.engagementName }
				: null,
		lastExport:
			row.exportId &&
			row.exportStatus &&
			row.exportTargetKind &&
			row.exportCreatedAt &&
			row.exportStatusChangedAt
				? {
						id: row.exportId,
						status: row.exportStatus,
						targetKind: row.exportTargetKind,
						createdAt: row.exportCreatedAt.toISOString(),
						statusChangedAt: row.exportStatusChangedAt.toISOString(),
					}
				: null,
		lastActivityAt: iso(row.lastActivityAt),
		needsYou: row.needsYou ? { reason: row.needsYou } : null,
		gateRunning: row.gateRunning === true,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The columns of a list item, shared by list and get. */
function itemFields(b: ReturnType<typeof base>) {
	return {
		id: mission.id,
		origin: mission.origin,
		type: mission.type,
		sprintN: mission.sprintN,
		status: mission.status,
		cut: mission.cut,
		cutSource: mission.cutSource,
		clientId: client.id,
		clientName: client.name,
		engagementId: engagement.id,
		engagementName: engagement.name,
		exportId: b.lx.id,
		exportStatus: b.lx.status,
		exportTargetKind: b.lx.targetKind,
		exportCreatedAt: b.lx.createdAt,
		exportStatusChangedAt: b.lx.statusChangedAt,
		lastActivityAt: b.la.at,
		needsYou: b.needsYou,
		// Qualified by hand: inside a raw select-list Drizzle leaves columns
		// unqualified, and the subquery would bind to its own table.
		gateRunning: sql<boolean>`exists (select 1 from "gate_job" where "gate_job"."mission_id" = "mission"."id" and "gate_job"."status" in ('queued', 'running'))`,
		clientSortKey: sql<string | null>`lower(${client.name}) collate "C"`,
		createdAt: mission.createdAt,
		updatedAt: mission.updatedAt,
	};
}

/** The mission as GET /api/missions/:id serves it, or 404. */
async function missionDetailOf(
	db: Executor,
	id: string,
): Promise<MissionDetail> {
	const b = base(db, id);
	const roster = db
		.select({
			missionId: rosterEntry.missionId,
			agents: sql<number>`count(*)`.mapWith(Number).as("agents"),
			active: sql<number>`count(*) filter (where ${rosterEntry.active})`
				.mapWith(Number)
				.as("active"),
		})
		.from(rosterEntry)
		.where(and(eq(rosterEntry.missionId, id), live(rosterEntry)))
		.groupBy(rosterEntry.missionId)
		.as("roster");

	// Query 1 of 4: the mission with every join.
	const [row] = await db
		.select({
			...itemFields(b),
			brief: mission.brief,
			spendCeilingUsd: mission.spendCeilingUsd,
			cutRationale: mission.cutRationale,
			repoUrl: mission.repoUrl,
			rosterAgents: roster.agents,
			rosterActive: roster.active,
			playbookType: playbook.missionType,
			playbookName: playbook.name,
		})
		.from(mission)
		.leftJoin(
			engagement,
			and(eq(engagement.id, mission.engagementId), live(engagement)),
		)
		.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.leftJoin(b.lx, eq(b.lx.missionId, mission.id))
		.leftJoin(b.la, eq(b.la.missionId, mission.id))
		.leftJoin(roster, eq(roster.missionId, mission.id))
		.leftJoin(
			playbook,
			and(eq(playbook.missionType, mission.type), live(playbook)),
		)
		.where(
			and(
				eq(mission.id, id),
				live(mission),
				or(
					eq(mission.origin, "internal"),
					and(isNotNull(engagement.id), isNotNull(client.id)),
				),
			),
		);
	if (!row) throw notFound("mission", id);

	// Query 2 of 4: the ten newest activity rows, with their actors,
	// joined as the activity feed joins them (no live()).
	const activity = await db
		.select({
			action: activityLog.action,
			entityType: activityLog.entityType,
			at: activityLog.at,
			...actorColumns,
		})
		.from(activityLog)
		.leftJoin(user, eq(user.id, activityLog.actorUserId))
		.leftJoin(rosterEntry, eq(rosterEntry.id, activityLog.actorRosterEntryId))
		.leftJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.where(eq(activityLog.missionId, id))
		.orderBy(desc(activityLog.at), desc(activityLog.id))
		.limit(10);

	// Query 3 of 4: what the mission's dispatches have spent.
	const spentUsd = await missionSpentUsd(db, id);

	// Query 4 of 4: the queued or running gate job, if any.
	const [job] = await db
		.select()
		.from(gateJob)
		.where(
			and(
				eq(gateJob.missionId, id),
				sql`${gateJob.status} in ('queued', 'running')`,
			),
		);
	const activeGateJob = job ? toJob(job, await jobsAhead(db, job)) : null;

	const item = toItem(row as ListRow);
	const detail: MissionDetail = {
		...item,
		brief: (row.brief ?? {}) as Record<string, unknown>,
		spendCeilingUsd:
			row.spendCeilingUsd === null ? null : Number(row.spendCeilingUsd),
		spentUsd,
		cutRationale: row.cutRationale,
		repoUrl: row.repoUrl,
		roster: {
			agents: row.rosterAgents ?? 0,
			active: row.rosterActive ?? 0,
		},
		playbook:
			row.playbookType && row.playbookName
				? { missionType: row.playbookType, name: row.playbookName }
				: null,
		lastExport: item.lastExport ? { ...item.lastExport, gates: null } : null,
		recentActivity: activity.map((a) => ({
			action: a.action,
			entityType: a.entityType,
			at: a.at.toISOString(),
			actor: activityActor(a),
		})),
		activeGateJob,
	};
	return detail;
}

export function missionRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(missionContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const b = base(db);
			const key = sortKey(query.sort, b.la.at);
			const dir = query.direction ?? key.defaultDir;
			const tag = cursorTag(query.sort, dir, key.defaultDir);
			const where = scope(query);
			const cursor = query.cursor
				? decodeCursor(query.cursor, query.sort, tag)
				: undefined;
			// The filters the list applies beyond its scope. meta.counts ignores
			// them; meta.total respects them.
			const filters = and(
				query.status ? inArray(mission.status, query.status) : undefined,
				query.needsYou ? sql`${b.needsYou} is not null` : undefined,
				query.quietBefore
					? sql`(${b.la.at} is null or ${b.la.at} < ${query.quietBefore}::timestamptz)`
					: undefined,
				query.lastExportStatus
					? inArray(b.lx.status, query.lastExportStatus)
					: undefined,
			);

			// Query 1 of 2: the page.
			const rows = (await db
				.select(itemFields(b))
				.from(mission)
				.leftJoin(
					engagement,
					and(eq(engagement.id, mission.engagementId), live(engagement)),
				)
				.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
				.leftJoin(b.lx, eq(b.lx.missionId, mission.id))
				.leftJoin(b.la, eq(b.la.missionId, mission.id))
				.where(
					and(where, filters, cursor ? after(key, dir, cursor) : undefined),
				)
				.orderBy(...orderFor(key, dir))
				.limit(query.limit + 1)) as ListRow[];

			// Query 2 of 2: per status, over the scope: every row for meta.counts,
			// and the rows the filters keep for meta.total.
			const countRows = await db
				.select({
					status: mission.status,
					n: sql<number>`count(*)`.mapWith(Number),
					needsYou:
						sql<number>`count(*) filter (where ${b.needsYou} is not null)`.mapWith(
							Number,
						),
					matching: (filters
						? sql<number>`count(*) filter (where ${filters})`
						: sql<number>`count(*)`
					).mapWith(Number),
				})
				.from(mission)
				.leftJoin(
					engagement,
					and(eq(engagement.id, mission.engagementId), live(engagement)),
				)
				.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
				.leftJoin(b.lx, eq(b.lx.missionId, mission.id))
				.leftJoin(b.la, eq(b.la.missionId, mission.id))
				.where(where)
				.groupBy(mission.status);

			const byStatus = Object.fromEntries(
				MISSION_STATUSES.map((s) => [s, 0]),
			) as Record<MissionStatus, number>;
			let needsYou = 0;
			let total = 0;
			for (const r of countRows) {
				byStatus[r.status] = r.n;
				needsYou += r.needsYou;
				total += r.matching;
			}

			const page = rows.slice(0, query.limit);
			const last = page.at(-1);
			const nextCursor =
				rows.length > query.limit && last
					? encodeCursor({
							tag,
							id: last.id,
							value:
								query.sort === "lastActivity"
									? iso(last.lastActivityAt)
									: query.sort === "sprint"
										? last.sprintN
										: last.clientSortKey,
						})
					: null;

			return {
				status: 200,
				body: {
					success: true as const,
					data: page.map(toItem),
					meta: { nextCursor, total, counts: { byStatus, needsYou } },
				},
			};
		},

		get: async ({ params }) => ({
			status: 200,
			body: ok(await missionDetailOf(deps.db(), params.id)),
		}),

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const to = body.spendCeilingUsd?.toFixed(2) ?? null;
			await withTx(deps.db(), async (tx) => {
				// Locked, so a status change cannot race the rule below. Visible as
				// GET is: a client mission whose engagement or client is removed is 404.
				const [m] = await tx
					.select({
						status: mission.status,
						engagementId: mission.engagementId,
						spendCeilingUsd: mission.spendCeilingUsd,
					})
					.from(mission)
					.leftJoin(
						engagement,
						and(eq(engagement.id, mission.engagementId), live(engagement)),
					)
					.leftJoin(
						client,
						and(eq(client.id, engagement.clientId), live(client)),
					)
					.where(
						and(
							eq(mission.id, params.id),
							live(mission),
							or(
								eq(mission.origin, "internal"),
								and(isNotNull(engagement.id), isNotNull(client.id)),
							),
						),
					)
					.for("update", { of: mission });
				if (!m) throw notFound("mission", params.id);
				if (m.status !== "draft" && m.status !== "active") {
					throw new ApiError(
						"PRECONDITION_FAILED",
						`A ${m.status} mission's spend ceiling cannot change`,
						{ details: { reason: "mission_not_editable" } },
					);
				}
				// The same value again changes nothing, so a retry is safe.
				if (m.spendCeilingUsd === to) return;
				// A running mission's ceiling only goes up: lowering it under what
				// is already spent would halt every dispatch on the next tick, and
				// clearing it would remove the only cap on the mission's total.
				if (
					m.status === "active" &&
					m.spendCeilingUsd !== null &&
					(to === null || Number(to) < Number(m.spendCeilingUsd))
				) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						`An active mission's spend ceiling only goes up, from ${m.spendCeilingUsd}`,
						{ details: { reason: "spend_ceiling_not_raised" } },
					);
				}
				await tx
					.update(mission)
					.set({ spendCeilingUsd: to, ...touch(deps.clock) })
					.where(eq(mission.id, params.id));
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.spend_ceiling_set",
					entityType: "mission",
					entityId: params.id,
					missionId: params.id,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload: {
						from: m.spendCeilingUsd === null ? null : Number(m.spendCeilingUsd),
						to: to === null ? null : Number(to),
					},
				});
			});
			return {
				status: 200,
				body: ok(await missionDetailOf(deps.db(), params.id)),
			};
		},
	});
}
