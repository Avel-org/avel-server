import { tsr } from "@ts-rest/serverless/fetch";
import { and, eq } from "drizzle-orm";
import {
	contract,
	type Finding,
	ok,
	type ReportFindingBody,
} from "../contract";
import { logActivity } from "../db/activity";
import { dispatchWire, reportWire } from "../db/dispatch";
import { agentTemplate, engagement, finding, mission } from "../db/schema";
import { stamp } from "../db/schema/columns";
import { type Tx, withTx } from "../db/tx";
import { requestSha256 } from "../lib/canonical";
import type { AgentCaller } from "../middleware/caller";
import { ApiError } from "../middleware/errors";
import { fileAgentReport } from "../runner/report";
import type { RunnerDeps } from "../runner/runner";
import {
	actorOf,
	agentOf,
	type RequestContext,
	type RouteDeps,
} from "./shared";

type FindingRow = typeof finding.$inferSelect;

/** The contract's Finding, field by field: the key and request hash stay off the wire. */
export function toFindingWire(r: FindingRow): Finding {
	return {
		id: r.id,
		missionId: r.missionId,
		clientId: r.clientId,
		rule: r.rule,
		subject: r.subject,
		severity: r.severity,
		class: r.class,
		status: r.status,
		dismissedReason: r.dismissedReason,
		caughtBy: r.caughtBy,
		reportedByDispatchId: r.reportedByDispatchId,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	};
}

/** Header on a replayed create (DATA-CONTRACTS-V2.md, Idempotency). */
const REPLAYED = "idempotency-replayed";

/**
 * Two retries racing on one key both find nothing and both insert; the
 * partial unique index stops the second. Postgres aborts the transaction
 * on that error, so it is caught outside withTx and the request re-run,
 * which then finds the first one's finding.
 */
function isKeyViolation(err: unknown): boolean {
	for (let e = err; e instanceof Error; e = e.cause) {
		const pg = e as Error & { code?: string; constraint_name?: string };
		if (
			pg.code === "23505" &&
			pg.constraint_name === "finding_dispatch_idempotency_key_uq"
		)
			return true;
	}
	return false;
}

type Reported = { replayed: boolean; row: FindingRow };

/**
 * The finding this dispatch already filed under `key`: replayed when the
 * body hash matches, 409 IDEMPOTENCY_REPLAY when it does not.
 */
async function replay(
	tx: Tx,
	dispatchId: string,
	key: string,
	sha256: string,
): Promise<Reported | null> {
	const [existing] = await tx
		.select()
		.from(finding)
		.where(
			and(
				eq(finding.reportedByDispatchId, dispatchId),
				eq(finding.idempotencyKey, key),
			),
		);
	if (!existing) return null;
	if (existing.requestSha256 !== sha256) {
		throw new ApiError(
			"IDEMPOTENCY_REPLAY",
			"This idempotency key was used with a different body",
		);
	}
	return { replayed: true, row: existing };
}

async function reportFinding(
	deps: RouteDeps,
	agent: AgentCaller,
	body: ReportFindingBody,
	key: string,
	requestId: string,
): Promise<Reported> {
	const { dispatch } = agent;
	const missionId = dispatch.missionId;
	// A firm dispatch has no mission, and no family that may act a finding
	// is a firm one; refused anyway rather than trusted to the table.
	if (!missionId) {
		throw new ApiError("AGENT_NOT_PERMITTED", "A finding belongs to a mission");
	}
	// "Its own" comes from the token. A body may name the mission and the
	// dispatch, and then must name these.
	if (
		(body.missionId !== undefined && body.missionId !== missionId) ||
		(body.dispatchId !== undefined && body.dispatchId !== dispatch.id)
	) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"A finding is filed on the calling dispatch's own mission",
			{ details: { reason: "report_dispatch_mismatch" } },
		);
	}
	const sha256 = requestSha256(body);
	return withTx(deps.db(), async (tx) => {
		const replayed = await replay(tx, dispatch.id, key, sha256);
		if (replayed) return replayed;

		const [owner] = await tx
			.select({
				engagementId: mission.engagementId,
				clientId: engagement.clientId,
			})
			.from(mission)
			.innerJoin(engagement, eq(engagement.id, mission.engagementId))
			.where(eq(mission.id, missionId));
		const [template] = await tx
			.select({ slug: agentTemplate.slug })
			.from(agentTemplate)
			.where(eq(agentTemplate.id, agent.rosterEntry.agentTemplateId));
		// The dispatch's FKs guarantee both; missing is a server bug.
		if (!owner || !template) {
			throw new Error(`dispatch ${dispatch.id} has no mission or template`);
		}

		const row: FindingRow = {
			id: deps.ids.next(),
			missionId,
			clientId: owner.clientId,
			rule: body.rule,
			subject: body.subject,
			severity: body.severity,
			class: body.class,
			status: "open",
			dismissedReason: null,
			caughtBy: template.slug,
			reportedByDispatchId: dispatch.id,
			idempotencyKey: key,
			requestSha256: sha256,
			...stamp(deps.clock),
		};
		await tx.insert(finding).values(row);
		await logActivity(tx, deps, {
			...actorOf(agent),
			action: "finding.opened",
			entityType: "finding",
			entityId: row.id,
			missionId,
			engagementId: owner.engagementId,
			requestId,
			payload: {
				severity: row.severity,
				rule: row.rule,
				dispatchId: dispatch.id,
			},
		});
		return { replayed: false, row };
	});
}

/**
 * The routes an agent calls with its dispatch's token. The caller
 * middleware has already checked the token and the agent's families;
 * agentOf refuses any other caller.
 */
export function agentRoutes(deps: RouteDeps & RunnerDeps) {
	return tsr.platformContext<RequestContext>().router(contract.agent, {
		dispatch: async (_req, ctx) => {
			const agent = agentOf(ctx);
			const wire = await dispatchWire(deps.db(), agent.dispatch.id);
			// The middleware just read this dispatch; gone now is a server bug.
			if (!wire) throw new Error(`dispatch ${agent.dispatch.id} vanished`);
			return { status: 200, body: ok(wire) };
		},

		reportFinding: async ({ body, headers }, ctx) => {
			const agent = agentOf(ctx);
			const key = headers["idempotency-key"];
			const run = () => reportFinding(deps, agent, body, key, ctx.requestId);
			let result: Reported;
			try {
				result = await run();
			} catch (err) {
				if (!isKeyViolation(err)) throw err;
				result = await run();
			}
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(toFindingWire(result.row)) };
			}
			return { status: 201, body: ok(toFindingWire(result.row)) };
		},

		report: async ({ body }, ctx) => {
			const agent = agentOf(ctx);
			const id = await fileAgentReport(deps, agent, body, ctx.requestId);
			const wire = await reportWire(deps.db(), id);
			if (!wire) throw new Error(`report ${id} vanished`);
			return { status: 201, body: ok(wire) };
		},
	});
}
