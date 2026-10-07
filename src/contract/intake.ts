import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { missionCut } from "./mission";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";
import { intakeStatus } from "./shared/status";

const c = initContract();

const uuid = z.string().uuid();
const iso = z.string().datetime();

export const requirementId = z
	.string()
	.regex(/^R[1-9][0-9]*$/, "A requirement id is R and a number: R1, R2, ...");
export const criterionId = z
	.string()
	.regex(/^AC[1-9][0-9]*$/, "A criterion id is AC and a number: AC1, AC2, ...");

/**
 * The brief Canon drafts and the operator approves. Held here and nowhere
 * else, so a different shape changes only this schema. Ids are permanent:
 * a criterion cites its requirement by id, never by position.
 *
 * This is structure only. Whether the ids are unique, every criterion cites a
 * requirement, and every requirement has a criterion is checkIntake's job
 * (src/lib/intake-check.ts), so a draft can be saved half-finished.
 */
export const briefSchema = z
	.object({
		summary: z.string().trim().min(1).max(5_000),
		requirements: z
			.array(
				z
					.object({
						id: requirementId,
						text: z.string().trim().min(1).max(2_000),
					})
					.strict(),
			)
			.max(500),
		acceptanceCriteria: z
			.array(
				z
					.object({
						id: criterionId,
						requirementId,
						text: z.string().trim().min(1).max(2_000),
					})
					.strict(),
			)
			.max(2_000),
	})
	.strict();

export type Brief = z.infer<typeof briefSchema>;

const openQuestion = z.string().trim().min(1).max(2_000);

/** Distinct, so acknowledging them is a set comparison with no ambiguity. */
const openQuestions = z
	.array(openQuestion)
	.max(100)
	.refine((qs) => new Set(qs).size === qs.length, {
		message: "Open questions must be distinct",
	});

const sourceMd = z.string().min(1).max(100_000);

/** One Intake: its columns in camelCase. */
export const intakeSchema = z.object({
	id: uuid,
	engagementId: uuid,
	status: intakeStatus,
	sourceMd: z.string(),
	proposedBrief: briefSchema.nullable(),
	openQuestions: z.array(z.string()),
	/** Computed by reading the repository (module 2). Null until then. */
	derivedCut: missionCut.nullable(),
	derivedCutEvidence: z.string().nullable(),
	/** Deferred: an open record until module 2 builds ConventionSet. */
	derivedConventions: z.record(z.string(), z.unknown()).nullable(),
	/** Deferred: open records until module 2 builds Boundary. */
	derivedBoundaries: z.array(z.record(z.string(), z.unknown())).nullable(),
	suggestedPresetId: uuid.nullable(),
	/** All three are set exactly when status is approved. */
	approvedBy: uuid.nullable(),
	approvedAt: iso.nullable(),
	missionId: uuid.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type Intake = z.infer<typeof intakeSchema>;

/** A new intake is always a draft, drafted by the operator until module 6. */
export const createIntakeBody = z
	.object({
		engagementId: uuid,
		sourceMd,
		proposedBrief: briefSchema.nullable().optional(),
		openQuestions: openQuestions.optional(),
	})
	.strict();

/** Revise. On a proposed intake it also sends the intake back to draft. */
export const updateIntakeBody = z
	.object({
		sourceMd: sourceMd.optional(),
		proposedBrief: briefSchema.nullable().optional(),
		openQuestions: openQuestions.optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

export const approveIntakeBody = z
	.object({
		missionType: z.string().trim().min(1).max(100),
		repoUrl: z
			.string()
			.url()
			.max(500)
			.refine((u) => u.startsWith("https://"), {
				message: "The repository URL must be https",
			}),
		/**
		 * Every open question, word for word: an answered question is removed
		 * through revise instead. Recorded in the intake.approved ActivityLog row.
		 */
		acknowledged: z.array(openQuestion).max(100).default([]),
	})
	.strict();

export const rejectIntakeBody = z
	.object({ reason: z.string().trim().min(1).max(2_000) })
	.strict();

export const intakeListQuery = pageQuery.extend({
	engagementId: uuid.optional(),
	/** Several at once, repeated (?status=draft&status=proposed) or indexed. */
	status: z
		.union([intakeStatus, z.array(intakeStatus)])
		.transform((v) => (Array.isArray(v) ? v : [v]))
		.optional(),
});

export const intakeListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(intakeSchema),
	meta: pageMeta.extend({
		/** The exact number of intakes the filters keep, ignoring the cursor. */
		total: z.number().int().nonnegative(),
	}),
});

const byId = z.object({ id: uuid });

export const intakeContract = c.router({
	list: {
		method: "GET",
		path: "/api/intakes",
		query: intakeListQuery,
		responses: { 200: intakeListEnvelope },
		summary: "Intakes, newest first",
	},
	get: {
		method: "GET",
		path: "/api/intakes/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(intakeSchema) },
	},
	create: {
		method: "POST",
		path: "/api/intakes",
		body: createIntakeBody,
		responses: { 201: successEnvelope(intakeSchema) },
		summary: "A draft, under a live, active engagement",
	},
	revise: {
		method: "PATCH",
		path: "/api/intakes/:id",
		pathParams: byId,
		body: updateIntakeBody,
		responses: { 200: successEnvelope(intakeSchema) },
		summary: "Draft or proposed; a proposed intake returns to draft",
	},
	propose: {
		method: "POST",
		path: "/api/intakes/:id/propose",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(intakeSchema) },
		summary:
			"Draft to proposed. 422 intake_check_failed lists what the check found.",
	},
	approve: {
		method: "POST",
		path: "/api/intakes/:id/approve",
		pathParams: byId,
		body: approveIntakeBody,
		responses: { 200: successEnvelope(intakeSchema) },
		summary:
			"Proposed to approved, creating the Mission. Re-runs the check, with every open question acknowledged.",
	},
	reject: {
		method: "POST",
		path: "/api/intakes/:id/reject",
		pathParams: byId,
		body: rejectIntakeBody,
		responses: { 200: successEnvelope(intakeSchema) },
		summary: "Draft or proposed to rejected, which is terminal",
	},
});
