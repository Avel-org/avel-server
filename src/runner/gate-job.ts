import { and, asc, eq } from "drizzle-orm";
import type { GateJobFailure } from "../contract/gate-job";
import type { PreconditionReason } from "../contract/shared/errors";
import { logActivity } from "../db/activity";
import { gateJob } from "../db/schema";
import { type Executor, withTx } from "../db/tx";
import type { CheckRunner } from "../gateways/check-runner";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { ApiError } from "../middleware/errors";
import type { RoomSourceResolver } from "../rooms/sources";
import {
	type GateMission,
	type GateRunPayload,
	gateJudge,
	gateMission,
	recordGateRun,
	runChecks,
	runnableCount,
} from "../routes/gate";

/**
 * Background gate runs (decided 2026-10-23). The POST checks the
 * preconditions and queues a job; this tick runs the oldest queued job:
 *
 * 1. Judge with no check results, which re-checks the preconditions and
 *    fixes the integration commit.
 * 2. Run the brief's checks on that commit, outside any transaction, with
 *    progress written after each one.
 * 3. Judge again with the results. If the integration commit moved (a
 *    dispatch closed meanwhile), the checks ran on the wrong commit: the job
 *    fails integration_moved. Otherwise the run is recorded and the job is
 *    done, in one transaction.
 *
 * One job at a time, server-wide: the loop never overlaps itself, and the
 * claim skips a row another process holds.
 */
export type GateJobDeps = {
	db: () => Executor;
	clock: Clock;
	ids: IdGenerator;
	roomSources: RoomSourceResolver;
	checkRunner: CheckRunner | null;
};

/** How long a job may run before it is failed timed_out. [hypothesis] */
export const GATE_JOB_LIMIT_MS = 2 * 60 * 60_000;

export type GateJobTickResult =
	| { jobId: null }
	| {
			jobId: string;
			status: "done" | "failed";
			failure: GateJobFailure | null;
	  };

type Failure = {
	code: GateJobFailure;
	reason: PreconditionReason | null;
	message: string;
};

/** The job stopped being running before it could be marked done. */
class Superseded extends Error {}

/** A precondition refusal as the job's failure; anything else rethrows. */
function preconditionOf(err: unknown): Failure | null {
	if (err instanceof ApiError && err.code === "PRECONDITION_FAILED") {
		const reason = (err.details as { reason?: PreconditionReason } | undefined)
			?.reason;
		return {
			code: "precondition_failed",
			reason: reason ?? null,
			message: err.message,
		};
	}
	if (err instanceof ApiError && err.code === "NOT_FOUND") {
		// The mission was deleted or hidden after the POST.
		return {
			code: "precondition_failed",
			reason: "mission_not_active",
			message: err.message,
		};
	}
	return null;
}

async function fail(
	deps: GateJobDeps,
	job: { id: string; missionId: string },
	failure: Failure,
): Promise<void> {
	await withTx(deps.db(), async (tx) => {
		const now = deps.clock.now();
		const [row] = await tx
			.update(gateJob)
			.set({
				status: "failed",
				failureCode: failure.code,
				failureReason: failure.reason,
				failureMessage: failure.message,
				currentCheckId: null,
				finishedAt: now,
				updatedAt: now,
			})
			.where(and(eq(gateJob.id, job.id), eq(gateJob.status, "running")))
			.returning({ id: gateJob.id });
		if (!row) return;
		const m = await gateMission(tx, job.missionId).catch(() => null);
		await logActivity(tx, deps, {
			actorKind: "system",
			action: "mission.gate_failed",
			entityType: "mission",
			entityId: job.missionId,
			missionId: job.missionId,
			engagementId: m?.engagementId ?? null,
			requestId: deps.ids.next(),
			payload: {
				jobId: job.id,
				failure: { code: failure.code, reason: failure.reason },
			},
		});
	});
}

/**
 * At startup: a job left running by a stopped server can never finish, so
 * it fails interrupted, and the runner removes what its runs left. Assumes
 * one server process: a second one starting would fail the first's job.
 * Returns the jobs it failed.
 */
export async function sweepGateJobs(deps: GateJobDeps): Promise<string[]> {
	// What a run left behind, such as a container, goes first.
	await deps.checkRunner?.sweep?.();
	const running = await deps
		.db()
		.select({ id: gateJob.id, missionId: gateJob.missionId })
		.from(gateJob)
		.where(eq(gateJob.status, "running"))
		.orderBy(asc(gateJob.id));
	for (const job of running) {
		await fail(deps, job, {
			code: "interrupted",
			reason: null,
			message: "The server stopped while this job ran",
		});
	}
	return running.map((j) => j.id);
}

/** Runs the oldest queued job, if any, to done or failed. */
export async function gateJobTick(
	deps: GateJobDeps,
): Promise<GateJobTickResult> {
	const judge = gateJudge(deps);
	const claimed = await withTx(deps.db(), async (tx) => {
		const [next] = await tx
			.select()
			.from(gateJob)
			.where(eq(gateJob.status, "queued"))
			.orderBy(asc(gateJob.queuedAt), asc(gateJob.id))
			.limit(1)
			.for("update", { skipLocked: true });
		if (!next) return null;
		const now = deps.clock.now();
		await tx
			.update(gateJob)
			.set({ status: "running", startedAt: now, updatedAt: now })
			.where(eq(gateJob.id, next.id));
		return { ...next, startedAt: now };
	});
	if (!claimed) return { jobId: null };

	const overrides = claimed.overrides as GateRunPayload["overrides"];
	const ended = async (failure: Failure): Promise<GateJobTickResult> => {
		await fail(deps, claimed, failure);
		return { jobId: claimed.id, status: "failed", failure: failure.code };
	};

	try {
		// 1. The commit the checks will run on, and the preconditions again.
		let first: Awaited<ReturnType<typeof judge>>;
		try {
			first = await withTx(deps.db(), async (tx) => {
				const m = await gateMission(tx, claimed.missionId);
				return judge(tx, m, overrides, new Map());
			});
		} catch (err) {
			const f = preconditionOf(err);
			if (f) return ended(f);
			throw err;
		}
		// The commit the POST judged: overrides bind to it, so a job that
		// would gate another one fails instead.
		if (claimed.commitSha !== null && first.commitSha !== claimed.commitSha) {
			return ended({
				code: "integration_moved",
				reason: null,
				message: `A dispatch closed while the job was queued: it was queued at ${claimed.commitSha}, and the mission is now at ${first.commitSha}`,
			});
		}

		// 2. The checks, outside any transaction.
		const total = deps.checkRunner ? runnableCount(first.checks) : 0;
		const progress = (checksDone: number, currentCheckId: string | null) =>
			deps
				.db()
				.update(gateJob)
				.set({
					checksTotal: total,
					checksDone,
					currentCheckId,
					updatedAt: deps.clock.now(),
				})
				.where(and(eq(gateJob.id, claimed.id), eq(gateJob.status, "running")))
				.then(() => undefined);
		const overLimit = () =>
			deps.clock.now().getTime() - claimed.startedAt.getTime() >
			GATE_JOB_LIMIT_MS;
		await progress(0, null);
		const ran = await runChecks(
			deps.checkRunner,
			first.source,
			first.commitSha,
			first.checks,
			progress,
			overLimit,
		);

		if (overLimit()) {
			return ended({
				code: "timed_out",
				reason: null,
				message: `The job ran longer than ${GATE_JOB_LIMIT_MS / 60_000} minutes`,
			});
		}

		// 3. Judge with the results, and record the run if the work held still.
		const outcome = await withTx(
			deps.db(),
			async (tx): Promise<{ failure: Failure } | { failure: null }> => {
				let m: GateMission;
				let judged: Awaited<ReturnType<typeof judge>>;
				try {
					m = await gateMission(tx, claimed.missionId);
					judged = await judge(tx, m, overrides, ran);
				} catch (err) {
					const f = preconditionOf(err);
					if (f) return { failure: f };
					throw err;
				}
				if (judged.commitSha !== first.commitSha) {
					return {
						failure: {
							code: "integration_moved",
							reason: null,
							message: `A dispatch closed while the checks ran: they ran on ${first.commitSha}, and the mission is now at ${judged.commitSha}`,
						},
					};
				}
				const row = await recordGateRun(
					tx,
					deps,
					m,
					judged,
					{
						jobId: claimed.id,
						operatorId: claimed.operatorId,
						overrides,
						idempotencyKey: claimed.idempotencyKey,
						requestSha256: claimed.requestSha256,
					},
					deps.ids.next(),
				);
				const now = deps.clock.now();
				const [marked] = await tx
					.update(gateJob)
					.set({
						status: "done",
						gateRunId: row.id,
						checksDone: total,
						currentCheckId: null,
						finishedAt: now,
						updatedAt: now,
					})
					.where(and(eq(gateJob.id, claimed.id), eq(gateJob.status, "running")))
					.returning({ id: gateJob.id });
				// Something else ended the job meanwhile: the run rolls back with it.
				if (!marked) throw new Superseded();
				return { failure: null };
			},
		);
		if (outcome.failure) return ended(outcome.failure);
		return { jobId: claimed.id, status: "done", failure: null };
	} catch (err) {
		if (err instanceof Superseded) {
			return { jobId: claimed.id, status: "failed", failure: null };
		}
		return ended({
			code: "internal",
			reason: null,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
