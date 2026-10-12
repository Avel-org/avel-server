import { tsr } from "@ts-rest/serverless/fetch";
import { and, eq } from "drizzle-orm";
import {
	type Brief,
	briefSchema,
	type MissionPlan,
	missionPlanContract,
	ok,
} from "../contract";
import { logActivity } from "../db/activity";
import { intake, mission } from "../db/schema";
import { live, touch } from "../db/schema/columns";
import { type Executor, withTx } from "../db/tx";
import { approvedBriefChanges, checkPlan } from "../lib/plan-check";
import { ApiError } from "../middleware/errors";
import {
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
} from "./shared";

const planColumns = {
	id: mission.id,
	brief: mission.brief,
	templateRef: mission.templateRef,
	templateVersion: mission.templateVersion,
};

type PlanRow = {
	id: string;
	brief: unknown;
	templateRef: string | null;
	templateVersion: string | null;
};

function toPlan(row: PlanRow, approved: Brief | null): MissionPlan {
	const parsed = briefSchema.safeParse(row.brief);
	const issues = checkPlan(row.brief);
	return {
		missionId: row.id,
		brief: parsed.success ? parsed.data : null,
		approvedBrief: approved,
		templateRef: row.templateRef,
		templateVersion: row.templateVersion,
		check: { passed: issues.length === 0, issues },
	};
}

async function onePlan(db: Executor, id: string): Promise<PlanRow> {
	const [row] = await db
		.select(planColumns)
		.from(mission)
		.where(and(eq(mission.id, id), live(mission)));
	if (!row) throw notFound("mission", id);
	return row;
}

/**
 * The brief the operator approved at Intake, or null for a mission no intake
 * created. An approved intake is never revised again, so this is fixed.
 * It parsed when approved, and briefSchema changes only additively, so a
 * failure here is a 500 on purpose: a non-additive brief change must migrate
 * the stored briefs first.
 */
async function approvedBrief(
	db: Executor,
	missionId: string,
): Promise<Brief | null> {
	const [row] = await db
		.select({ brief: intake.proposedBrief })
		.from(intake)
		.where(and(eq(intake.missionId, missionId), eq(intake.status, "approved")));
	if (!row) return null;
	const parsed = briefSchema.safeParse(row.brief);
	if (!parsed.success) {
		throw new Error(
			`the approved brief of mission ${missionId} does not parse`,
		);
	}
	return parsed.data;
}

export function missionPlanRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(missionPlanContract, {
		get: async ({ params }) => {
			const db = deps.db();
			const row = await onePlan(db, params.id);
			return {
				status: 200,
				body: ok(toPlan(row, await approvedBrief(db, params.id))),
			};
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const plan = await withTx(deps.db(), async (tx) => {
				// Locked, so the draft-only rule cannot be raced by a status change.
				const [m] = await tx
					.select({
						status: mission.status,
						engagementId: mission.engagementId,
						type: mission.type,
					})
					.from(mission)
					.where(and(eq(mission.id, params.id), live(mission)))
					.for("update");
				if (!m) throw notFound("mission", params.id);
				if (m.status !== "draft") {
					throw new ApiError(
						"PRECONDITION_FAILED",
						`A ${m.status} mission's plan cannot change`,
						{ details: { reason: "mission_not_editable" } },
					);
				}
				// A template's playbook is keyed by its slug, and missions join
				// their playbook on type, so the two must agree.
				if (body.templateRef !== null && body.templateRef !== m.type) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						`A ${m.type} mission cannot record template ${body.templateRef}: a templated mission's type is its template`,
						{
							details: {
								reason: "template_type_mismatch",
								...(m.engagementId ? { engagementId: m.engagementId } : {}),
							},
						},
					);
				}
				const approved = await approvedBrief(tx, params.id);
				const changed = approved
					? approvedBriefChanges(approved, body.brief)
					: [];
				if (changed.length > 0) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The plan changes the brief the operator approved",
						{
							details: {
								reason: "plan_changes_approved_brief",
								...(m.engagementId ? { engagementId: m.engagementId } : {}),
								issues: changed,
							},
						},
					);
				}
				await tx
					.update(mission)
					.set({
						brief: body.brief,
						templateRef: body.templateRef,
						templateVersion: body.templateVersion,
						...touch(deps.clock),
					})
					.where(eq(mission.id, params.id));
				const row = await onePlan(tx, params.id);
				const result = toPlan(row, approved);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.plan_updated",
					entityType: "mission",
					entityId: params.id,
					missionId: params.id,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload: {
						modules: body.brief.modules.length,
						requirements: body.brief.requirements.length,
						templateRef: body.templateRef,
						templateVersion: body.templateVersion,
						checkPassed: result.check.passed,
					},
				});
				return result;
			});
			return { status: 200, body: ok(plan) };
		},
	});
}
