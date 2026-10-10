import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { briefSchema } from "./intake";
import { successEnvelope } from "./shared/envelope";

const c = initContract();

/** Lowercase words joined by single hyphens, like 'template-booking'. */
export const templateRef = z
	.string()
	.max(100)
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, digits and hyphens");

/** The template repository's commit sha: 40 lowercase hex characters. */
export const templateVersion = z
	.string()
	.regex(/^[0-9a-f]{40}$/, "A full commit sha: 40 lowercase hex characters");

const checkIssue = z
	.object({
		path: z.array(z.union([z.string(), z.number()])),
		message: z.string(),
	})
	.strict();

/**
 * A mission's plan (module 3): the brief with its modules, and the template
 * it was built from. `check` is the mechanical plan check on the stored
 * brief; saving does not require it to pass.
 */
export const missionPlanSchema = z.object({
	missionId: z.string().uuid(),
	/** Null when the stored brief predates the brief shape and does not parse. */
	brief: briefSchema.nullable(),
	/**
	 * The brief the operator approved at Intake, which the plan may add to but
	 * not change. Null for a mission no Intake created.
	 */
	approvedBrief: briefSchema.nullable(),
	templateRef: templateRef.nullable(),
	templateVersion: templateVersion.nullable(),
	check: z.object({
		passed: z.boolean(),
		/** Rule, then position. Empty exactly when passed. */
		issues: z.array(checkIssue),
	}),
});

export type MissionPlan = z.infer<typeof missionPlanSchema>;

/**
 * Replaces the plan on a draft mission. The approved brief's summary,
 * requirements and criteria must be unchanged; the plan adds to them.
 * templateRef and templateVersion are both set or both null.
 */
export const updateMissionPlanBody = z
	.object({
		brief: briefSchema,
		templateRef: templateRef.nullable(),
		templateVersion: templateVersion.nullable(),
	})
	.strict()
	.refine((b) => (b.templateRef === null) === (b.templateVersion === null), {
		message: "templateRef and templateVersion are set together or not at all",
		path: ["templateVersion"],
	});

export type UpdateMissionPlanBody = z.infer<typeof updateMissionPlanBody>;

const byMission = z.object({ id: z.string().uuid() });

export const missionPlanContract = c.router({
	get: {
		method: "GET",
		path: "/api/missions/:id/plan",
		pathParams: byMission,
		responses: { 200: successEnvelope(missionPlanSchema) },
		summary: "The mission's plan and its mechanical check",
	},
	update: {
		method: "PUT",
		path: "/api/missions/:id/plan",
		pathParams: byMission,
		body: updateMissionPlanBody,
		responses: { 200: successEnvelope(missionPlanSchema) },
		summary:
			"Replaces a draft mission's plan. Refuses a change to the approved brief.",
	},
});
