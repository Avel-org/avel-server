import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { successEnvelope } from "./shared/envelope";
import { preconditionDetails } from "./shared/errors";
import { missionStatus } from "./shared/status";

const c = initContract();

/**
 * What stops a draft mission from starting, in the order start checks it.
 * Start refuses with the first; readiness lists them all.
 */
export const READINESS_REASONS = [
	"mission_not_draft",
	"engagement_closed",
	"plan_check_failed",
	"coherence_blocked",
	"estimate_missing",
] as const;

export const readinessReason = z.enum(READINESS_REASONS);

/**
 * What readiness shows but start does not refuse. A mission with no spend
 * ceiling has no mission-wide spend halt, only each dispatch's token
 * ceilings (J, 2026-10-20: the ceiling is optional).
 */
export const READINESS_WARNINGS = ["spend_ceiling_missing"] as const;

export const readinessWarning = z
	.object({ reason: z.enum(READINESS_WARNINGS) })
	.strict();

export type ReadinessWarning = z.infer<typeof readinessWarning>;

/**
 * One blocker: the details a refused start would carry for it. Issue paths
 * are stable and part of the contract; messages are for logs.
 * - plan_check_failed: checkPlan's issues, paths from "brief".
 * - coherence_blocked: one issue at ["coherence", "block"] with wave set, or
 *   at ["playbook"] when no live playbook matches the mission type.
 * - estimate_missing: rosterEntryIds, and one issue per entry at
 *   ["roster", entryId, "estimatedTokens"].
 * - engagement_closed: engagementId.
 */
export const readinessBlocker = preconditionDetails
	.pick({ issues: true, rosterEntryIds: true, wave: true, engagementId: true })
	.extend({ reason: readinessReason })
	.strict();

export type ReadinessBlocker = z.infer<typeof readinessBlocker>;

export const missionReadiness = z.object({
	missionId: z.string().uuid(),
	/** True exactly when blockers is empty. */
	ready: z.boolean(),
	blockers: z.array(readinessBlocker),
	/** Never blocks: ready ignores them. */
	warnings: z.array(readinessWarning),
});

export type MissionReadiness = z.infer<typeof missionReadiness>;

/** A status change start or halt made. */
export const missionStatusChange = z.object({
	missionId: z.string().uuid(),
	from: missionStatus,
	to: missionStatus,
	at: z.string().datetime(),
});

export type MissionStatusChange = z.infer<typeof missionStatusChange>;

const byId = z.object({ id: z.string().uuid() });

export const missionLifecycleContract = c.router({
	readiness: {
		method: "GET",
		path: "/api/missions/:id/readiness",
		pathParams: byId,
		responses: { 200: successEnvelope(missionReadiness) },
		summary: "Everything that stops the mission starting, in start's order",
	},
	start: {
		method: "POST",
		path: "/api/missions/:id/start",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(missionStatusChange) },
		summary:
			"draft → active; refuses with the first readiness blocker, then template_not_rosterable for a Firm template on the roster",
	},
	halt: {
		method: "POST",
		path: "/api/missions/:id/halt",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(missionStatusChange) },
		summary: "active → halted, by the operator",
	},
});
