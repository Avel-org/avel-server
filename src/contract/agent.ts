import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { dispatch } from "./dispatch";
import { successEnvelope } from "./shared/envelope";
import { idempotencyHeaders } from "./shared/idempotency";

const c = initContract();

/**
 * Agent access (DATA-CONTRACTS-V2.md, Dispatch; ROLES.md, What each family
 * may do through the API). An agent calls with its dispatch's token as
 * `Authorization: Bearer`. Every route an agent may reach declares what it
 * touches in `metadata.agent`; a route without one refuses every agent with
 * 403 AGENT_NOT_PERMITTED. Only routes under /api/agent/* declare one
 * (tests/unit/agent-routes.test.ts).
 */

/** The three verbs of ROLES.md. */
export const AGENT_VERBS = ["read", "act", "propose"] as const;

export type AgentVerb = (typeof AGENT_VERBS)[number];

/** What an agent route touches. Grows with the routes that need it. */
export const AGENT_RESOURCES = [
	"dispatch",
	"completion_report",
	"finding",
] as const;

export type AgentResource = (typeof AGENT_RESOURCES)[number];

/** What "its own" means for a route: derived from the token, never sent. */
export const AGENT_OWNERSHIP = ["dispatch", "mission"] as const;

export type AgentOwnership = (typeof AGENT_OWNERSHIP)[number];

export type AgentRouteDeclaration = {
	resource: AgentResource;
	verb: AgentVerb;
	own: AgentOwnership;
};

/** A route's access metadata. `system: true` lets the runner's credential through. */
export type RouteAccess = {
	agent?: AgentRouteDeclaration;
	system?: true;
};

/** Must equal the finding_severity pgEnum; tests/db/agent-contract.test.ts checks it. */
export const FINDING_SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
] as const;

export const findingSeverity = z.enum(FINDING_SEVERITIES);

export type FindingSeverity = z.infer<typeof findingSeverity>;

/** Must equal the finding_status pgEnum. */
export const FINDING_STATUSES = ["open", "confirmed", "dismissed"] as const;

export const findingStatus = z.enum(FINDING_STATUSES);

export type FindingStatus = z.infer<typeof findingStatus>;

/** A defect recorded against a mission (DATA-CONTRACTS-V2.md, Finding). */
export const finding = z.object({
	id: z.string().uuid(),
	missionId: z.string().uuid(),
	clientId: z.string().uuid().nullable(),
	rule: z.string(),
	subject: z.string(),
	severity: findingSeverity,
	class: z.string(),
	status: findingStatus,
	dismissedReason: z.string().nullable(),
	/** The check or agent that found it: an agent's template slug. */
	caughtBy: z.string(),
	/** The run that reported it; null when code or the operator recorded it. */
	reportedByDispatchId: z.string().uuid().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export type Finding = z.infer<typeof finding>;

const text = z.string().trim().min(1);

/**
 * A judge's defect. The server sets the mission, client, caught_by and the
 * reporting dispatch from the token. missionId and dispatchId may be sent,
 * and must then name the token's own (422 report_dispatch_mismatch).
 */
export const reportFindingBody = z
	.object({
		rule: text,
		subject: text,
		severity: findingSeverity,
		class: text,
		missionId: z.string().uuid().optional(),
		dispatchId: z.string().uuid().optional(),
	})
	.strict();

export type ReportFindingBody = z.infer<typeof reportFindingBody>;

// Keyed per dispatch here. Defined in shared/ so dispatch.ts can use it
// without a cycle through this file; still exported from here.
export { idempotencyHeaders };

export const agentContract = c.router({
	dispatch: {
		method: "GET",
		path: "/api/agent/dispatch",
		responses: { 200: successEnvelope(dispatch) },
		metadata: {
			agent: { resource: "dispatch", verb: "read", own: "dispatch" },
		} satisfies RouteAccess,
		summary: "The calling agent's own dispatch",
	},
	reportFinding: {
		method: "POST",
		path: "/api/agent/findings",
		headers: idempotencyHeaders,
		body: reportFindingBody,
		responses: {
			201: successEnvelope(finding),
			200: successEnvelope(finding),
		},
		metadata: {
			agent: { resource: "finding", verb: "act", own: "mission" },
		} satisfies RouteAccess,
		summary:
			"Records an open Finding on the calling agent's mission. Review families only. 200 replays the same key and body; 409 IDEMPOTENCY_REPLAY for a different body; 422 report_dispatch_mismatch when the body names another mission or dispatch",
	},
});
