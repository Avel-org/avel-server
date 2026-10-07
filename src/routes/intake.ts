import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
	type Brief,
	type Intake,
	type IntakeStatus,
	intakeContract,
	ok,
} from "../contract";
import { logActivity } from "../db/activity";
import { client, engagement, intake, mission } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { checkIntake } from "../lib/intake-check";
import { ApiError } from "../middleware/errors";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof intake.$inferSelect;

/** Database row (snake_case columns, Dates) to wire shape (camelCase, ISO strings). */
function toWire(row: Row): Intake {
	return {
		id: row.id,
		engagementId: row.engagementId,
		status: row.status,
		sourceMd: row.sourceMd,
		proposedBrief: row.proposedBrief as Brief | null,
		openQuestions: row.openQuestions,
		derivedCut: row.derivedCut,
		derivedCutEvidence: row.derivedCutEvidence,
		derivedConventions: row.derivedConventions as Record<
			string,
			unknown
		> | null,
		derivedBoundaries: row.derivedBoundaries as Array<
			Record<string, unknown>
		> | null,
		suggestedPresetId: row.suggestedPresetId,
		approvedBy: row.approvedBy,
		approvedAt: row.approvedAt?.toISOString() ?? null,
		missionId: row.missionId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * An intake is visible while it, its engagement and its client are live, as
 * a client mission is. Inner joins, so a removed parent hides it.
 */
function visible(db: Executor) {
	return db
		.select(getTableColumns(intake))
		.from(intake)
		.innerJoin(
			engagement,
			and(eq(engagement.id, intake.engagementId), live(engagement)),
		)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.$dynamic();
}

/**
 * The intake, locked for the rest of the transaction. Every transition reads
 * through here, so two writers on one intake run one after the other and the
 * second sees the first's status. Propose and approve check the content they
 * locked, so a concurrent revise cannot slip an unchecked brief past them.
 */
async function lockIntake(tx: Tx, id: string): Promise<Row> {
	const [row] = await visible(tx)
		.where(and(eq(intake.id, id), live(intake)))
		.for("update", { of: intake });
	if (!row) throw notFound("intake", id);
	return row;
}

function wrongState(row: Row, action: string): ApiError {
	return new ApiError("CONFLICT", `A ${row.status} intake cannot be ${action}`);
}

/**
 * The engagement, locked for share so it cannot be closed or removed between
 * this check and the write that depends on it.
 */
async function requireActiveEngagement(tx: Tx, engagementId: string) {
	const [parent] = await tx
		.select({ status: engagement.status })
		.from(engagement)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(engagement.id, engagementId), live(engagement)))
		.for("share", { of: engagement });
	if (!parent) {
		throw new ApiError("PRECONDITION_FAILED", "The engagement does not exist", {
			details: { reason: "engagement_not_found", engagementId },
		});
	}
	if (parent.status !== "active") {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"A closed engagement cannot take this intake",
			{ details: { reason: "engagement_closed", engagementId } },
		);
	}
}

function checkFailed(issues: ReturnType<typeof checkIntake>): ApiError {
	return new ApiError(
		"PRECONDITION_FAILED",
		"The intake does not pass the mechanical check",
		{ details: { reason: "intake_check_failed", issues } },
	);
}

export function intakeRoutes(deps: RouteDeps) {
	/** Applies `set` to a locked intake and logs `action`, in the caller's transaction. */
	async function transition(
		tx: Tx,
		ctx: RequestContext,
		row: Row,
		set: Partial<typeof intake.$inferInsert>,
		action:
			| "intake.updated"
			| "intake.proposed"
			| "intake.approved"
			| "intake.rejected",
		payload: Record<string, unknown>,
	): Promise<Row> {
		const operator = operatorOf(ctx);
		const [updated] = await tx
			.update(intake)
			.set({ ...set, ...touch(deps.clock) })
			.where(and(eq(intake.id, row.id), eq(intake.status, row.status)))
			.returning();
		// lockIntake holds the row, so its status cannot have moved.
		if (!updated) throw new Error(`intake ${row.id} changed while locked`);
		await logActivity(tx, deps, {
			actorKind: "operator",
			actorUserId: operator.id,
			action,
			entityType: "intake",
			entityId: row.id,
			missionId: updated.missionId,
			engagementId: row.engagementId,
			requestId: ctx.requestId,
			payload,
		});
		return updated;
	}

	return tsr.platformContext<RequestContext>().router(intakeContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = and(
				live(intake),
				query.engagementId
					? eq(intake.engagementId, query.engagementId)
					: undefined,
				query.status
					? inArray(intake.status, query.status as IntakeStatus[])
					: undefined,
			);
			// The page and the total in one round. The total uses the filters
			// without the cursor, so it is the same on every page.
			const [rows, [counted]] = await Promise.all([
				visible(db)
					.where(and(filters, after(intake, query.cursor)))
					.orderBy(desc(intake.createdAt), desc(intake.id))
					.limit(query.limit + 1),
				db
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(intake)
					.innerJoin(
						engagement,
						and(eq(engagement.id, intake.engagementId), live(engagement)),
					)
					.innerJoin(
						client,
						and(eq(client.id, engagement.clientId), live(client)),
					)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map(toWire),
					meta: { nextCursor, total: counted?.n ?? 0 },
				},
			};
		},

		get: async ({ params }) => {
			const [row] = await visible(deps.db()).where(
				and(eq(intake.id, params.id), live(intake)),
			);
			if (!row) throw notFound("intake", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				await requireActiveEngagement(tx, body.engagementId);
				const values = {
					id: deps.ids.next(),
					engagementId: body.engagementId,
					status: "draft" as const,
					sourceMd: body.sourceMd,
					proposedBrief: body.proposedBrief ?? null,
					openQuestions: body.openQuestions ?? [],
					...stamp(deps.clock),
				};
				const [inserted] = await tx.insert(intake).values(values).returning();
				if (!inserted) throw new Error("intake insert returned no row");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "intake.created",
					entityType: "intake",
					entityId: values.id,
					engagementId: values.engagementId,
					requestId: ctx.requestId,
					payload: {},
				});
				return inserted;
			});
			return { status: 201, body: ok(toWire(row)) };
		},

		revise: async ({ params, body }, ctx) => {
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft" && current.status !== "proposed") {
					throw wrongState(current, "revised");
				}
				// The source can run to 100k characters, so the log names the
				// fields that changed rather than copying them.
				return transition(
					tx,
					ctx,
					current,
					{ ...body, status: "draft" },
					"intake.updated",
					{
						fields: Object.keys(body).sort(),
						from: current.status,
					},
				);
			});
			return { status: 200, body: ok(toWire(row)) };
		},

		propose: async ({ params }, ctx) => {
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft") throw wrongState(current, "proposed");
				const issues = checkIntake(current);
				if (issues.length > 0) throw checkFailed(issues);
				return transition(
					tx,
					ctx,
					current,
					{ status: "proposed" },
					"intake.proposed",
					{},
				);
			});
			return { status: 200, body: ok(toWire(row)) };
		},

		approve: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "proposed")
					throw wrongState(current, "approved");
				await requireActiveEngagement(tx, current.engagementId);
				const issues = checkIntake({
					...current,
					acknowledged: body.acknowledged,
				});
				if (issues.length > 0) throw checkFailed(issues);
				// The cut is derived from the repository (module 2), never chosen
				// here, so an intake whose repository has not been read waits.
				if (current.derivedCut === null) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The repository has not been read, so there is no derived cut",
						{
							details: {
								reason: "intake_cut_not_derived",
								engagementId: current.engagementId,
							},
						},
					);
				}
				const now = deps.clock.now();
				const missionId = deps.ids.next();
				await tx.insert(mission).values({
					id: missionId,
					engagementId: current.engagementId,
					origin: "client",
					type: body.missionType,
					brief: current.proposedBrief as Brief,
					sprintN: 1,
					status: "draft",
					cut: current.derivedCut,
					cutSource: "derived",
					cutRationale: null,
					repoUrl: body.repoUrl,
					spendCeilingUsd: null,
					deletedAt: null,
					...stamp(deps.clock),
				});
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.created",
					entityType: "mission",
					entityId: missionId,
					missionId,
					engagementId: current.engagementId,
					requestId: ctx.requestId,
					payload: { intakeId: current.id, type: body.missionType },
				});
				return transition(
					tx,
					ctx,
					current,
					{
						status: "approved",
						approvedBy: operator.id,
						approvedAt: now,
						missionId,
					},
					"intake.approved",
					{ missionId, acknowledged: body.acknowledged },
				);
			});
			return { status: 200, body: ok(toWire(row)) };
		},

		reject: async ({ params, body }, ctx) => {
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft" && current.status !== "proposed") {
					throw wrongState(current, "rejected");
				}
				return transition(
					tx,
					ctx,
					current,
					{ status: "rejected" },
					"intake.rejected",
					{ reason: body.reason },
				);
			});
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
