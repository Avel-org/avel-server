import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, ilike, inArray, type SQL, sql } from "drizzle-orm";
import {
	earliestWave,
	ok,
	type Playbook,
	type PlaybookListQuery,
	page,
	playbookContract,
	playbookSchema,
	type UpdatePlaybookBody,
} from "../contract";
import { logActivity } from "../db/activity";
import { activityLog, mission, playbook, rosterPreset } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	after,
	containsPattern,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof playbook.$inferSelect;

function toWire(row: Row): Playbook {
	return {
		id: row.id,
		missionType: row.missionType,
		name: row.name,
		wavesApplicable: row.wavesApplicable,
		gates: row.gates.map((g) => ({ gate: g.gate, policy: g.policy })),
		deliverable: row.deliverable,
		requiredFields: row.requiredFields,
		defaultPresetId: row.defaultPresetId,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function filtersFor(query: PlaybookListQuery): SQL | undefined {
	return and(
		live(playbook),
		query.q ? ilike(playbook.name, containsPattern(query.q)) : undefined,
	);
}

function noPlaybook(missionType: string): ApiError {
	return new ApiError(
		"NOT_FOUND",
		`No playbook for mission type ${missionType}`,
	);
}

function typeTaken(missionType: string): ApiError {
	return new ApiError(
		"CONFLICT",
		`A live playbook already exists for mission type ${missionType}`,
	);
}

/** The live playbook for a type. mission_type is unique among live rows (playbook_mission_type_live_uq). */
async function livePlaybook(
	db: Executor,
	missionType: string,
	lock = false,
): Promise<Row> {
	const query = db
		.select()
		.from(playbook)
		.where(and(eq(playbook.missionType, missionType), live(playbook)));
	const [row] = await (lock ? query.for("update") : query);
	if (!row) throw noPlaybook(missionType);
	return row;
}

/**
 * The default preset is live, and at least one of its agents is in the
 * earliest wave the playbook declares, so applying it can clear the
 * first-wave block. One earliestWave serves this check and coherence.
 */
async function requireUsablePreset(
	tx: Tx,
	body: Pick<UpdatePlaybookBody, "defaultPresetId" | "wavesApplicable">,
): Promise<void> {
	const [preset] = await tx
		.select({ agents: rosterPreset.agents })
		.from(rosterPreset)
		.where(and(eq(rosterPreset.id, body.defaultPresetId), live(rosterPreset)));
	if (!preset)
		throw new ApiError("PRECONDITION_FAILED", "The preset does not exist", {
			details: { reason: "preset_not_found" },
		});
	const first = earliestWave(body);
	if (first === null || !preset.agents.some((a) => a.waves.includes(first)))
		throw new ApiError(
			"PRECONDITION_FAILED",
			`The default preset has no agent in wave ${first ?? "(none)"}, the earliest the playbook declares`,
			{ details: { reason: "preset_misses_first_wave" } },
		);
}

/** Refuses while a live mission of this type is running or halted mid-run. */
async function requireNotInUse(tx: Tx, missionType: string): Promise<void> {
	const [running] = await tx
		.select({ id: mission.id })
		.from(mission)
		.where(
			and(
				eq(mission.type, missionType),
				inArray(mission.status, ["active", "halted"]),
				live(mission),
			),
		)
		.limit(1);
	if (running)
		throw new ApiError(
			"PRECONDITION_FAILED",
			`A ${missionType} mission is active or halted, so its playbook cannot change`,
			{ details: { reason: "playbook_in_use" } },
		);
}

/**
 * Two creates racing on one mission type both pass the pre-check; the partial
 * unique index stops the second. Postgres aborts the transaction on that
 * error, so it is translated outside withTx, never caught inside it.
 */
function isTypeViolation(err: unknown): boolean {
	for (let e = err; e instanceof Error; e = e.cause) {
		const pg = e as Error & { code?: string; constraint_name?: string };
		if (
			pg.code === "23505" &&
			pg.constraint_name === "playbook_mission_type_live_uq"
		)
			return true;
	}
	return false;
}

export function playbookRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(playbookContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(playbook)
					.where(and(filters, after(playbook, query.cursor)))
					.orderBy(desc(playbook.createdAt), desc(playbook.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(playbook)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(items.map(toWire), nextCursor, counted?.total ?? 0),
			};
		},

		getForType: async ({ params }) => {
			const row = await livePlaybook(deps.db(), params.missionType);
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			try {
				const row = await withTx(deps.db(), async (tx) => {
					const [taken] = await tx
						.select({ id: playbook.id })
						.from(playbook)
						.where(
							and(eq(playbook.missionType, body.missionType), live(playbook)),
						)
						.limit(1);
					if (taken) throw typeTaken(body.missionType);
					await requireUsablePreset(tx, body);
					const values = {
						id: deps.ids.next(),
						missionType: body.missionType,
						name: body.name,
						wavesApplicable: body.wavesApplicable,
						gates: body.gates,
						deliverable: body.deliverable,
						requiredFields: body.requiredFields,
						defaultPresetId: body.defaultPresetId,
						version: 1,
						deletedAt: null,
						...stamp(deps.clock),
					};
					await tx.insert(playbook).values(values);
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "playbook.created",
						entityType: "playbook",
						entityId: values.id,
						requestId: ctx.requestId,
						// The whole playbook as written: versions reads it back.
						payload: toWire(values),
					});
					return values;
				});
				return { status: 201, body: ok(toWire(row)) };
			} catch (err) {
				if (isTypeViolation(err)) throw typeTaken(body.missionType);
				throw err;
			}
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				// Locked FOR UPDATE, so concurrent updates bump the version one at a time.
				const current = await livePlaybook(tx, params.missionType, true);
				await requireNotInUse(tx, params.missionType);
				await requireUsablePreset(tx, body);
				const [updated] = await tx
					.update(playbook)
					.set({
						name: body.name,
						wavesApplicable: body.wavesApplicable,
						gates: body.gates,
						deliverable: body.deliverable,
						requiredFields: body.requiredFields,
						defaultPresetId: body.defaultPresetId,
						version: current.version + 1,
						...touch(deps.clock),
					})
					.where(eq(playbook.id, current.id))
					.returning();
				if (!updated) throw new Error("a locked playbook was not updatable");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "playbook.updated",
					entityType: "playbook",
					entityId: updated.id,
					requestId: ctx.requestId,
					payload: toWire(updated),
				});
				return updated;
			});
			return { status: 200, body: ok(toWire(row)) };
		},

		versions: async ({ params }) => {
			const db = deps.db();
			const current = await livePlaybook(db, params.missionType);
			const rows = await db
				.select({ payload: activityLog.payload })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.entityType, "playbook"),
						eq(activityLog.entityId, current.id),
						inArray(activityLog.action, [
							"playbook.created",
							"playbook.updated",
						]),
					),
				)
				// Each write logs its version, so the version is the order.
				.orderBy(
					sql`(${activityLog.payload}->>'version')::int desc`,
					desc(activityLog.at),
					desc(activityLog.id),
				);
			// A playbook written before writes were logged (the seed's, for one)
			// has no rows; its current state is its only known version.
			const versions =
				rows.length > 0
					? rows.map((r) => playbookSchema.parse(r.payload))
					: [toWire(current)];
			return { status: 200, body: ok(versions) };
		},
	});
}
