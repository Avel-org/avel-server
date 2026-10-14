import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { missionCut } from "./mission";
import { boundarySchema, conventionSetSchema } from "./repo-read";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";
import { parseGitHubRepoUrl } from "./shared/repo-url";
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
export const moduleId = z
	.string()
	.regex(/^M[1-9][0-9]*$/, "A module id is M and a number: M1, M2, ...");
export const checkId = z
	.string()
	.regex(/^CK[1-9][0-9]*$/, "A check id is CK and a number: CK1, CK2, ...");

/**
 * How a requirement is shown done without taking the agent's word (step 9,
 * docs/STEP-9-PLAN.md). file_exists names a path; the other kinds name a
 * command. The gate (module 9) runs them, never the agent.
 */
export const CHECK_KINDS = [
	"file_exists",
	"test",
	"typecheck",
	"command",
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * A path or glob relative to the repository root, written with /. Never
 * absolute, never with a `..` segment. Whether it matches anything is a
 * question for the room at dispatch time, not for the plan.
 */
export const repoPath = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.refine((p) => !/^([/\\]|[A-Za-z]:)/.test(p), {
		message: "A repository path is relative to the repository root",
	})
	.refine((p) => !p.split(/[/\\]/).includes(".."), {
		message: "A repository path may not contain a .. segment",
	});

const checkNote = z.string().trim().min(1).max(500).optional();
const checkCommand = z.string().trim().min(1).max(1_000);

export const briefCheck = z.discriminatedUnion("kind", [
	z
		.object({
			id: checkId,
			requirementId,
			kind: z.literal("file_exists"),
			path: repoPath,
			note: checkNote,
		})
		.strict(),
	z
		.object({
			id: checkId,
			requirementId,
			kind: z.literal("test"),
			command: checkCommand,
			note: checkNote,
		})
		.strict(),
	z
		.object({
			id: checkId,
			requirementId,
			kind: z.literal("typecheck"),
			command: checkCommand,
			note: checkNote,
		})
		.strict(),
	z
		.object({
			id: checkId,
			requirementId,
			kind: z.literal("command"),
			command: checkCommand,
			note: checkNote,
		})
		.strict(),
]);

export type BriefCheck = z.infer<typeof briefCheck>;

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
		/**
		 * How the work splits (module 3). The operator writes it on a draft
		 * Mission; Intake leaves it empty. A brief stored before modules
		 * existed parses with none.
		 */
		modules: z
			.array(
				z
					.object({
						id: moduleId,
						name: z.string().trim().min(1).max(200),
						requirementIds: z.array(requirementId).max(500),
						/**
						 * The brief's Read section (step 9): the repository paths or
						 * globs the module's agent reads, at the room's commit. A
						 * module written before step 9 parses with none.
						 */
						reads: z.array(repoPath).max(100).default([]),
					})
					.strict(),
			)
			.max(200)
			.default([]),
		/**
		 * The brief's Done-when section (step 9): each requirement's checks
		 * outside the agent. The plan adds them, like modules; a brief stored
		 * before step 9 parses with none.
		 */
		checks: z.array(briefCheck).max(2_000).default([]),
	})
	.strict();

export type Brief = z.infer<typeof briefSchema>;
/** A brief as a request body may send it: modules may be left out. */
export type BriefInput = z.input<typeof briefSchema>;

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
	/** The conventions the read extracted. A low one blocks approval. */
	derivedConventions: conventionSetSchema.nullable(),
	derivedBoundaries: z.array(boundarySchema).nullable(),
	/**
	 * The repository the derived fields were read from, normalized
	 * (https://github.com/owner/repo), and the commit they describe. All three
	 * are set by read-repo, and approve requires its repoUrl to match.
	 */
	repoUrl: z.string().nullable(),
	repoCommitSha: z.string().nullable(),
	repoReadAt: iso.nullable(),
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

/** A GitHub repository URL: https://github.com/owner/repo, optionally ending .git or /. */
const githubRepoUrl = z
	.string()
	.max(500)
	.refine((u) => parseGitHubRepoUrl(u) !== null, {
		message: "Give a GitHub repository URL: https://github.com/owner/repo",
	});

/**
 * Reads the repository through a Connection of the intake's engagement and
 * writes the derived fields. A re-read replaces them; it never changes status.
 */
export const readRepoBody = z
	.object({
		connectionId: uuid,
		repoUrl: githubRepoUrl,
		/** A branch, tag or sha. Omitted: the default branch's head. */
		ref: z.string().trim().min(1).max(250).optional(),
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
	readRepo: {
		method: "POST",
		path: "/api/intakes/:id/read-repo",
		pathParams: byId,
		body: readRepoBody,
		responses: { 200: successEnvelope(intakeSchema) },
		summary:
			"Draft or proposed. Reads the repository once and writes the cut, conventions and boundaries, with their evidence.",
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
