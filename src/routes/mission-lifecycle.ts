import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, eq } from "drizzle-orm";
import {
	computeCoherence,
	type MissionStatus,
	type MissionStatusChange,
	missionLifecycleContract,
	ok,
	type ReadinessBlocker,
	resolveWritablePaths,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	agentTemplate,
	client,
	engagement,
	mission,
	playbook,
	rosterEntry,
} from "../db/schema";
import { live, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { checkPlan } from "../lib/plan-check";
import { identitySupported } from "../lib/roles";
import { ApiError } from "../middleware/errors";
import {
	haltRunningDispatches,
	inStep,
	lockMission,
	type RunnerDeps,
} from "../runner/runner";
import {
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
} from "./shared";

type MissionRow = {
	id: string;
	status: MissionStatus;
	type: string;
	cut: "horizontal" | "vertical";
	brief: unknown;
	spendCeilingUsd: string | null;
	engagementId: string | null;
	engagementStatus: "active" | "closed" | null;
};

/**
 * The mission as the detail route sees it: live, and for a client mission,
 * with its engagement and client live too. Locked FOR UPDATE inside a write,
 * so start and halt serialize with every roster write (they lock it too).
 */
async function oneMission(
	db: Executor | Tx,
	id: string,
	lock: boolean,
): Promise<MissionRow> {
	const q = db
		.select({
			id: mission.id,
			status: mission.status,
			type: mission.type,
			cut: mission.cut,
			brief: mission.brief,
			spendCeilingUsd: mission.spendCeilingUsd,
			engagementId: mission.engagementId,
			engagementStatus: engagement.status,
			origin: mission.origin,
			clientId: client.id,
		})
		.from(mission)
		.leftJoin(
			engagement,
			and(eq(engagement.id, mission.engagementId), live(engagement)),
		)
		.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(mission.id, id), live(mission)));
	const [row] = await (lock ? q.for("update", { of: mission }) : q);
	if (!row || (row.origin === "client" && row.clientId === null)) {
		throw notFound("mission", id);
	}
	return row;
}

/**
 * Every blocker, in start's order (READINESS_REASONS). Pure over what it
 * reads: the same mission, roster and playbook give the same list.
 */
async function blockersFor(
	db: Executor | Tx,
	m: MissionRow,
): Promise<ReadinessBlocker[]> {
	const blockers: ReadinessBlocker[] = [];

	if (m.status !== "draft") blockers.push({ reason: "mission_not_draft" });

	if (m.engagementId !== null && m.engagementStatus === "closed") {
		blockers.push({
			reason: "engagement_closed",
			engagementId: m.engagementId,
		});
	}

	const planIssues = checkPlan(m.brief);
	if (planIssues.length > 0) {
		blockers.push({ reason: "plan_check_failed", issues: planIssues });
	}

	const entries = await db
		.select({
			id: rosterEntry.id,
			active: rosterEntry.active,
			waves: rosterEntry.waves,
			writablePaths: rosterEntry.writablePaths,
			territory: rosterEntry.territory,
			estimatedTokens: rosterEntry.estimatedTokens,
			name: agentTemplate.name,
			kind: agentTemplate.kind,
			roles: agentTemplate.roles,
			templatePaths: agentTemplate.writablePaths,
		})
		.from(rosterEntry)
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.where(and(eq(rosterEntry.missionId, m.id), live(rosterEntry)))
		.orderBy(asc(rosterEntry.createdAt), asc(rosterEntry.id));

	const [book] = await db
		.select({
			wavesApplicable: playbook.wavesApplicable,
			gates: playbook.gates,
		})
		.from(playbook)
		.where(and(eq(playbook.missionType, m.type), live(playbook)));
	if (!book) {
		blockers.push({
			reason: "coherence_blocked",
			issues: [
				{
					path: ["playbook"],
					message: `No live playbook matches mission type ${m.type}`,
				},
			],
		});
	} else {
		const { block } = computeCoherence(
			{
				cut: m.cut,
				roster: entries.map((e) => ({
					id: e.id,
					active: e.active,
					waves: e.waves,
					kind: e.kind,
					roles: e.roles,
					writablePaths: resolveWritablePaths(e, {
						writablePaths: e.templatePaths,
					}),
				})),
			},
			book,
		);
		if (block) {
			blockers.push({
				reason: "coherence_blocked",
				wave: block.wave,
				issues: [{ path: ["coherence", "block"], message: block.reason }],
			});
		}
	}

	// Only entries that can be dispatched need an estimate: an agent whose
	// every role is a model role. The operator's foundations entry is a
	// person and is never dispatched.
	const unestimated = entries.filter(
		(e) => e.active && e.estimatedTokens === null && identitySupported(e.roles),
	);
	if (unestimated.length > 0) {
		blockers.push({
			reason: "estimate_missing",
			rosterEntryIds: unestimated.map((e) => e.id),
			issues: unestimated.map((e) => ({
				path: ["roster", e.id, "estimatedTokens"],
				message: `${e.territory ? `${e.name} · ${e.territory}` : e.name} has no token estimate`,
			})),
		});
	}

	if (m.spendCeilingUsd === null) {
		blockers.push({ reason: "spend_ceiling_missing" });
	}

	return blockers;
}

const MESSAGES: Record<ReadinessBlocker["reason"], string> = {
	mission_not_draft: "Only a draft mission can start",
	engagement_closed: "The mission's engagement is closed",
	plan_check_failed: "The mission's plan does not pass its check",
	coherence_blocked: "The roster cannot staff the playbook's first wave",
	estimate_missing: "An active agent has no token estimate",
	spend_ceiling_missing: "The mission has no spend ceiling",
};

export function missionLifecycleRoutes(deps: RouteDeps & RunnerDeps) {
	/** One status change and its mission.status_changed row, in one transaction. */
	const change = async (
		tx: Tx,
		ctx: RequestContext,
		m: MissionRow,
		to: MissionStatus,
	): Promise<MissionStatusChange> => {
		const operator = operatorOf(ctx);
		const stamp = touch(deps.clock);
		await tx
			.update(mission)
			.set({ status: to, ...stamp })
			.where(eq(mission.id, m.id));
		await logActivity(tx, deps, {
			actorKind: "operator",
			actorUserId: operator.id,
			action: "mission.status_changed",
			entityType: "mission",
			entityId: m.id,
			missionId: m.id,
			engagementId: m.engagementId,
			requestId: ctx.requestId,
			payload: { from: m.status, to },
		});
		return {
			missionId: m.id,
			from: m.status,
			to,
			at: stamp.updatedAt.toISOString(),
		};
	};

	return tsr
		.platformContext<RequestContext>()
		.router(missionLifecycleContract, {
			readiness: async ({ params }) => {
				const db = deps.db();
				const m = await oneMission(db, params.id, false);
				const blockers = await blockersFor(db, m);
				return {
					status: 200,
					body: ok({ missionId: m.id, ready: blockers.length === 0, blockers }),
				};
			},

			start: async ({ params }, ctx) =>
				withTx(deps.db(), async (tx) => {
					const m = await oneMission(tx, params.id, true);
					const [first] = await blockersFor(tx, m);
					if (first) {
						throw new ApiError("PRECONDITION_FAILED", MESSAGES[first.reason], {
							details: { ...first, missionId: m.id },
						});
					}
					return { status: 200, body: ok(await change(tx, ctx, m, "active")) };
				}),

			// Halts the mission's running dispatches too, as the operator, in
			// the same transaction; their sessions stop once it commits.
			halt: async ({ params }, ctx) =>
				inStep(deps, async (step) => {
					const { tx } = step;
					const m = await oneMission(tx, params.id, true);
					if (m.status !== "active") {
						throw new ApiError(
							"PRECONDITION_FAILED",
							`A ${m.status} mission cannot be halted`,
							{ details: { reason: "mission_not_active", missionId: m.id } },
						);
					}
					const body = await change(tx, ctx, m, "halted");
					const locked = await lockMission(tx, m.id);
					if (!locked) throw new Error(`mission ${m.id} vanished`);
					await haltRunningDispatches(step, deps, locked, "operator", {
						actor: {
							actorKind: "operator",
							actorUserId: operatorOf(ctx).id,
						},
						requestId: ctx.requestId,
					});
					return { status: 200, body: ok(body) };
				}),
		});
}
