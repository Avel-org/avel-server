import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, eq, gt, max } from "drizzle-orm";
import {
	type BriefRef,
	briefSchema,
	type CreateDispatchBody,
	DEFAULT_WALL_CLOCK_MINUTES,
	dispatchContract,
	ok,
	page,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	dispatchWire,
	insertDispatch,
	listDispatches,
	listReports,
	reportWire,
} from "../db/dispatch";
import { currentIdentity } from "../db/identity";
import {
	agentTemplate,
	client,
	dispatch,
	dispatchStep,
	engagement,
	mission,
	rosterEntry,
} from "../db/schema";
import { live } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { requestSha256 } from "../lib/canonical";
import { uncheckedIssues } from "../lib/plan-check";
import { identitySupported } from "../lib/roles";
import { ApiError } from "../middleware/errors";
import {
	type Acting,
	closeBySystem,
	inStep,
	type LockedMission,
	lockDispatch,
	lockMission,
	missionOf,
	type RunnerDeps,
	startDispatch,
} from "../runner/runner";
import {
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
} from "./shared";

const REPLAYED = "Idempotency-Replayed";

type VisibleMission = {
	id: string;
	status: string;
	brief: unknown;
	engagementId: string | null;
};

/**
 * The mission as the detail route sees it: live, and for a client mission,
 * with a live engagement and client. Anything else is 404, so a dispatch
 * read never reveals a mission the detail route hides.
 */
async function visibleMission(
	db: Executor | Tx,
	id: string,
	lock = false,
): Promise<VisibleMission> {
	const q = db
		.select({
			id: mission.id,
			status: mission.status,
			brief: mission.brief,
			engagementId: mission.engagementId,
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

/** briefRef issues against the mission's plan, as body validation issues. */
function briefRefIssues(brief: unknown, ref: BriefRef) {
	const parsed = briefSchema.safeParse(brief);
	const module = parsed.success
		? parsed.data.modules.find((m) => m.id === ref.moduleId)
		: undefined;
	if (!module) {
		return [
			{
				path: ["briefRef", "moduleId"],
				message: `The mission's plan has no module ${ref.moduleId}`,
			},
		];
	}
	const listed = new Set(module.requirementIds);
	return ref.requirementIds.flatMap((rid, i) =>
		listed.has(rid)
			? []
			: [
					{
						path: ["briefRef", "requirementIds", i],
						message: `${module.id} does not list ${rid}`,
					},
				],
	);
}

function invalid(
	issues: Array<{ path: Array<string | number>; message: string }>,
) {
	return new ApiError(
		"VALIDATION_FAILED",
		"The dispatch does not fit the mission",
		{
			details: { body: issues },
		},
	);
}

/** A hidden mission's 404 becomes the child's own 404; anything else rethrows. */
const hiddenAs = (entity: string, id: string) => (err: unknown) => {
	if (err instanceof ApiError && err.code === "NOT_FOUND") {
		throw notFound(entity, id);
	}
	throw err;
};

type Created = { replayed: boolean; id: string };

async function create(
	deps: RouteDeps,
	ctx: RequestContext,
	missionId: string,
	key: string,
	body: CreateDispatchBody,
): Promise<Created> {
	const operator = operatorOf(ctx);
	const hash = requestSha256(body);
	return withTx(deps.db(), async (tx) => {
		// Locked: creates on one mission run one at a time, so a retried key
		// finds the first attempt's row rather than racing it.
		const m = await visibleMission(tx, missionId, true);

		const [prior] = await tx
			.select({ id: dispatch.id, requestSha256: dispatch.requestSha256 })
			.from(dispatch)
			.where(
				and(eq(dispatch.missionId, m.id), eq(dispatch.idempotencyKey, key)),
			);
		if (prior) {
			if (prior.requestSha256 !== hash) {
				throw new ApiError(
					"IDEMPOTENCY_REPLAY",
					"This Idempotency-Key was used with a different body",
				);
			}
			return { replayed: true, id: prior.id };
		}

		if (m.status !== "active") {
			throw new ApiError(
				"PRECONDITION_FAILED",
				`A ${m.status} mission takes no dispatches`,
				{ details: { reason: "mission_not_active", missionId: m.id } },
			);
		}

		const [entry] = await tx
			.select({
				id: rosterEntry.id,
				active: rosterEntry.active,
				estimatedTokens: rosterEntry.estimatedTokens,
				tokenSoftCeiling: rosterEntry.tokenSoftCeiling,
				tokenHardCeiling: rosterEntry.tokenHardCeiling,
				templateId: agentTemplate.id,
				roles: agentTemplate.roles,
			})
			.from(rosterEntry)
			.innerJoin(
				agentTemplate,
				eq(agentTemplate.id, rosterEntry.agentTemplateId),
			)
			.where(
				and(
					eq(rosterEntry.id, body.rosterEntryId),
					eq(rosterEntry.missionId, m.id),
					live(rosterEntry),
				),
			);
		const at = { missionId: m.id, rosterEntryIds: [body.rosterEntryId] };
		if (!entry) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				"The mission has no such roster entry",
				{ details: { reason: "roster_entry_not_found", ...at } },
			);
		}
		if (!entry.active) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				"The roster entry is inactive",
				{
					details: { reason: "roster_entry_inactive", ...at },
				},
			);
		}
		if (
			!identitySupported(entry.roles) ||
			(await currentIdentity(tx, entry.templateId)) === null
		) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				"The agent has no identity to run with",
				{ details: { reason: "agent_identity_missing", ...at } },
			);
		}

		const refIssues = briefRefIssues(m.brief, body.briefRef);
		if (refIssues.length > 0) throw invalid(refIssues);
		const unchecked = uncheckedIssues(m.brief, body.briefRef);
		if (unchecked.length > 0) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				"A requirement this dispatch is for has no check outside the agent",
				{
					details: {
						reason: "requirement_unchecked",
						missionId: m.id,
						issues: unchecked,
					},
				},
			);
		}

		const estimate = body.estimatedTokens ?? entry.estimatedTokens;
		if (estimate === null) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				"The dispatch has no token estimate",
				{
					details: {
						reason: "estimate_missing",
						...at,
						issues: [
							{
								path: ["roster", entry.id, "estimatedTokens"],
								message: "The roster entry has no token estimate",
							},
						],
					},
				},
			);
		}
		const soft =
			body.tokenSoftCeiling ??
			entry.tokenSoftCeiling ??
			Math.ceil(estimate * 1.5);
		const hard =
			body.tokenHardCeiling ?? entry.tokenHardCeiling ?? estimate * 3;
		const ceilingIssues = [
			...(soft < estimate
				? [
						{
							path: ["tokenSoftCeiling"],
							message: `The soft ceiling ${soft} is below the estimate ${estimate}`,
						},
					]
				: []),
			...(hard < soft
				? [
						{
							path: ["tokenHardCeiling"],
							message: `The hard ceiling ${hard} is below the soft ceiling ${soft}`,
						},
					]
				: []),
		];
		if (ceilingIssues.length > 0) throw invalid(ceilingIssues);

		const row = await insertDispatch(tx, deps.clock, deps.ids, {
			rosterEntryId: entry.id,
			missionId: m.id,
			briefRef: body.briefRef,
			status: "queued",
			haltReason: null,
			estimatedTokens: estimate,
			tokenSoftCeiling: soft,
			tokenHardCeiling: hard,
			tokensUsed: 0,
			tokensIn: 0,
			tokensOut: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			softCeilingCrossed: false,
			spendUsd: "0",
			wallClockMinutes: body.wallClockMinutes ?? DEFAULT_WALL_CLOCK_MINUTES,
			idempotencyKey: key,
			requestSha256: hash,
		});
		await logActivity(tx, deps, {
			actorKind: "operator",
			actorUserId: operator.id,
			action: "dispatch.created",
			entityType: "dispatch",
			entityId: row.id,
			missionId: m.id,
			engagementId: m.engagementId,
			requestId: ctx.requestId,
			payload: {
				rosterEntryId: entry.id,
				moduleId: body.briefRef.moduleId,
				estimatedTokens: estimate,
				tokenSoftCeiling: soft,
				tokenHardCeiling: hard,
			},
		});
		return { replayed: false, id: row.id };
	});
}

/**
 * The dispatch's mission, locked FOR UPDATE, before the dispatch is: 404
 * for the dispatch when it, or its mission, is not visible.
 */
async function lockedMissionOf(tx: Tx, id: string): Promise<LockedMission> {
	const missionId = await missionOf(tx, id);
	if (!missionId) throw notFound("dispatch", id);
	await visibleMission(tx, missionId, true).catch(hiddenAs("dispatch", id));
	const m = await lockMission(tx, missionId);
	if (!m) throw notFound("dispatch", id);
	return m;
}

/** The operator as the actor of a start or halt. */
function operatorActing(ctx: RequestContext): Acting {
	return {
		actor: { actorKind: "operator", actorUserId: operatorOf(ctx).id },
		requestId: ctx.requestId,
	};
}

/** The dispatch, or 404 when it, or the mission it belongs to, is not visible. */
async function visibleDispatch(db: Executor, id: string) {
	const wire = await dispatchWire(db, id);
	if (!wire) throw notFound("dispatch", id);
	await visibleMission(db, wire.missionId).catch(hiddenAs("dispatch", id));
	return wire;
}

export function dispatchRoutes(deps: RouteDeps & RunnerDeps) {
	return tsr.platformContext<RequestContext>().router(dispatchContract, {
		list: async ({ params, query }) => {
			const db = deps.db();
			await visibleMission(db, params.id);
			const { items, nextCursor } = await listDispatches(db, params.id, query);
			return { status: 200, body: page(items, nextCursor) };
		},

		get: async ({ params }) => {
			const wire = await visibleDispatch(deps.db(), params.id);
			return { status: 200, body: ok(wire) };
		},

		steps: async ({ params, query }) => {
			const db = deps.db();
			await visibleDispatch(db, params.id);
			const rows = await db
				.select()
				.from(dispatchStep)
				.where(
					and(
						eq(dispatchStep.dispatchId, params.id),
						gt(dispatchStep.seq, query.afterSeq),
					),
				)
				.orderBy(asc(dispatchStep.seq))
				.limit(query.limit);
			const [last] = await db
				.select({ seq: max(dispatchStep.seq) })
				.from(dispatchStep)
				.where(eq(dispatchStep.dispatchId, params.id));
			return {
				status: 200,
				body: {
					success: true as const,
					data: rows.map((r) => ({
						id: r.id,
						seq: r.seq,
						turn: null,
						kind: r.kind,
						label: r.label,
						detail: r.detail,
						startedAt: r.startedAt.toISOString(),
						endedAt: r.endedAt?.toISOString() ?? null,
						tokensIn: r.tokensIn,
						tokensOut: r.tokensOut,
					})),
					meta: { lastSeq: last?.seq ?? 0 },
				},
			};
		},

		brief: async ({ params }) => {
			const db = deps.db();
			await visibleDispatch(db, params.id);
			const [row] = await db
				.select({
					briefSha256: dispatch.briefSha256,
					briefMd: dispatch.briefMd,
				})
				.from(dispatch)
				.where(eq(dispatch.id, params.id));
			if (!row) throw notFound("dispatch", params.id);
			return { status: 200, body: ok({ dispatchId: params.id, ...row }) };
		},

		create: async ({ params, headers, body }, ctx) => {
			const result = await create(
				deps,
				ctx,
				params.id,
				headers["idempotency-key"],
				body,
			);
			const wire = await dispatchWire(deps.db(), result.id);
			if (!wire) throw new Error(`dispatch ${result.id} vanished`);
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(wire) };
			}
			return { status: 201, body: ok(wire) };
		},

		start: async ({ params }, ctx) => {
			const by = operatorActing(ctx);
			await inStep(deps, async (step) => {
				const m = await lockedMissionOf(step.tx, params.id);
				await startDispatch(step, deps, m, params.id, by);
			});
			const wire = await dispatchWire(deps.db(), params.id);
			if (!wire) throw new Error(`dispatch ${params.id} vanished`);
			return { status: 200, body: ok(wire) };
		},

		halt: async ({ params }, ctx) => {
			const by = operatorActing(ctx);
			await inStep(deps, async (step) => {
				const m = await lockedMissionOf(step.tx, params.id);
				const d = await lockDispatch(step.tx, params.id);
				if (!d) throw notFound("dispatch", params.id);
				if (d.status !== "running") {
					throw new ApiError(
						"PRECONDITION_FAILED",
						`A ${d.status} dispatch cannot be halted`,
						{
							details: {
								reason: "dispatch_not_running",
								dispatchId: d.id,
								missionId: m.id,
							},
						},
					);
				}
				await closeBySystem(
					step,
					deps,
					m,
					d,
					{ status: "halted", haltReason: "operator" },
					by,
				);
			});
			const wire = await dispatchWire(deps.db(), params.id);
			if (!wire) throw new Error(`dispatch ${params.id} vanished`);
			return { status: 200, body: ok(wire) };
		},

		reports: async ({ params, query }) => {
			const db = deps.db();
			await visibleMission(db, params.id);
			const { items, nextCursor } = await listReports(db, params.id, query);
			return { status: 200, body: page(items, nextCursor) };
		},

		report: async ({ params }) => {
			const db = deps.db();
			const wire = await reportWire(db, params.id);
			if (!wire) throw notFound("completion report", params.id);
			await visibleMission(db, wire.missionId).catch(
				hiddenAs("completion report", params.id),
			);
			return { status: 200, body: ok(wire) };
		},
	});
}
