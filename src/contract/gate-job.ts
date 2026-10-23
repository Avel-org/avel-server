import { z } from "zod";
import { preconditionReason } from "./shared/errors";

const iso = z.string().datetime();
const uuid = z.string().uuid();

/**
 * A gate run in the background (decided 2026-10-23): the POST queues a job,
 * the server's gate tick runs it, and a done job names the run it made.
 * One job runs at a time, server-wide.
 */
export const GATE_JOB_STATUSES = [
	"queued",
	"running",
	"done",
	"failed",
] as const;

export type GateJobStatus = (typeof GATE_JOB_STATUSES)[number];

/**
 * Why a job ended without a run. A runner that breaks is not one: its checks
 * are errors, and the run's result is fail.
 */
export const GATE_JOB_FAILURES = [
	/** A precondition that held at the POST failed when the job ran; `reason` names it. */
	"precondition_failed",
	/** A dispatch closed while the checks ran, so they ran on a commit that is no longer the mission's. */
	"integration_moved",
	/** The server stopped while the job ran. */
	"interrupted",
	/** The job ran past its limit (2 hours, [hypothesis]). */
	"timed_out",
	/** Anything unexpected. */
	"internal",
] as const;

export type GateJobFailure = (typeof GATE_JOB_FAILURES)[number];

export const gateJob = z.object({
	id: uuid,
	missionId: uuid,
	status: z.enum(GATE_JOB_STATUSES),
	/** The run this job made. Set only when done. */
	gateRunId: uuid.nullable(),
	/** Set only when failed. `reason` only for precondition_failed; `message` is for logs. */
	failure: z
		.object({
			code: z.enum(GATE_JOB_FAILURES),
			reason: preconditionReason.nullable(),
			message: z.string(),
		})
		.nullable(),
	/** Null while queued. `currentCheckId` is the brief's check id, null between checks. */
	progress: z
		.object({
			checksTotal: z.number().int().nonnegative(),
			checksDone: z.number().int().nonnegative(),
			currentCheckId: z.string().nullable(),
		})
		.nullable(),
	/** While queued: the jobs that will run before this one, a running job included. Null otherwise. */
	ahead: z.number().int().nonnegative().nullable(),
	queuedAt: iso,
	startedAt: iso.nullable(),
	finishedAt: iso.nullable(),
});

export type GateJob = z.infer<typeof gateJob>;
