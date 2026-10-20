import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { activityContract } from "./activity";
import { agentContract } from "./agent";
import {
	agentTemplateContract,
	identityVersionContract,
} from "./agent-template";
import { canonContract } from "./canon";
import { clientContract } from "./client";
import { connectionContract } from "./connection";
import { dispatchContract } from "./dispatch";
import { engagementContract } from "./engagement";
import { findingContract } from "./finding";
import { gateContract } from "./gate";
import { intakeContract } from "./intake";
import { intakeFileContract } from "./intake-file";
import { missionContract } from "./mission";
import { missionLifecycleContract } from "./mission-lifecycle";
import { missionPlanContract } from "./mission-plan";
import { playbookContract } from "./playbook";
import { presetContract } from "./preset";
import { rosterContract } from "./roster";
import { errorEnvelope, successEnvelope } from "./shared/envelope";
import { skillContract } from "./skill";
import { skillSourceContract } from "./skill-source";
import { templateContract } from "./template";

export * from "./activity";
export * from "./agent";
export * from "./agent-template";
export * from "./canon";
export * from "./client";
export * from "./connection";
export * from "./dispatch";
export * from "./engagement";
export * from "./finding";
export * from "./gate";
export * from "./intake";
export * from "./intake-file";
export * from "./mission";
export * from "./mission-lifecycle";
export * from "./mission-plan";
export * from "./playbook";
export * from "./preset";
export * from "./repo-read";
export * from "./role-labels";
export * from "./roster";
export * from "./shared/access";
export * from "./shared/coherence";
export * from "./shared/envelope";
export * from "./shared/errors";
export * from "./shared/pagination";
export * from "./shared/repo-url";
export * from "./shared/skill-tiers";
export * from "./shared/status";
export * from "./skill";
export * from "./skill-source";
export * from "./template";

/**
 * The contract between avel-server and every client: web, desktop, mobile.
 *
 * It lives here and avel-web consumes it as a dependency, so neither side can
 * change it without the other seeing the change.
 *
 * Every JSON route answers with the success envelope, and any route can
 * answer any of ERROR_STATUSES with the error envelope.
 */
const c = initContract();

export const healthResponse = z.object({
	ok: z.literal(true),
	service: z.literal("avel-server"),
	time: z.string().datetime(),
	/** True while dev preview lets sessionless reads through (AVEL_DEV_PREVIEW). */
	preview: z.boolean(),
});

export const contract = c.router(
	{
		health: {
			method: "GET",
			path: "/api/health",
			responses: { 200: successEnvelope(healthResponse) },
			summary: "Liveness, plus the server's clock — which tests can fix",
		},
		clients: clientContract,
		engagements: engagementContract,
		missions: missionContract,
		missionPlans: missionPlanContract,
		missionLifecycle: missionLifecycleContract,
		dispatches: dispatchContract,
		activity: activityContract,
		intakes: intakeContract,
		intakeFiles: intakeFileContract,
		findings: findingContract,
		gate: gateContract,
		connections: connectionContract,
		agentTemplates: agentTemplateContract,
		identityVersions: identityVersionContract,
		skills: skillContract,
		skillSources: skillSourceContract,
		roster: rosterContract,
		presets: presetContract,
		playbooks: playbookContract,
		templates: templateContract,
		agent: agentContract,
		canon: canonContract,
	},
	{
		// One entry per ERROR_STATUSES value. Written out, not mapped, so ts-rest
		// infers each status literally; tests/unit/error-mapping.test.ts checks
		// the two lists agree.
		commonResponses: {
			400: errorEnvelope,
			401: errorEnvelope,
			403: errorEnvelope,
			404: errorEnvelope,
			409: errorEnvelope,
			422: errorEnvelope,
			500: errorEnvelope,
			502: errorEnvelope,
		},
	},
);
