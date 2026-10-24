import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { missionOrigin } from "./mission";
import { successEnvelope } from "./shared/envelope";
import { idempotencyHeaders } from "./shared/idempotency";
import { pageEnvelope, pageMeta, pageQuery } from "./shared/pagination";
import { runStepsEnvelope, runStepsQuery } from "./shared/run-step";
import {
	completionStatus,
	DISPATCH_STATUSES,
	dispatchStatus,
	haltReason,
	missionStatus,
	versionSource,
} from "./shared/status";
import { wave } from "./shared/wave";

/**
 * Module 6 wire shapes and the operator's dispatch routes
 * (DATA-CONTRACTS-V2, Dispatch and CompletionReport).
 */

const c = initContract();

const iso = z.string().datetime();
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
const tokens = z.number().int().nonnegative();
/** US dollars. Spend accrues in fractions of a cent, so it is not rounded to cents. */
const usd = z.number().nonnegative();

/** The module and requirement ids a run is for, from the mission's plan. */
export const briefRef = z.object({
	moduleId: z.string().min(1),
	requirementIds: z.array(z.string().min(1)),
});

export type BriefRef = z.infer<typeof briefRef>;

/**
 * One run of one agent on one piece of work. Never carries the access
 * token or its hash.
 */
export const dispatch = z.object({
	id: uuid,
	missionId: uuid,
	rosterEntryId: uuid,
	agent: z.object({
		templateId: uuid,
		slug: z.string(),
		name: z.string(),
		title: z.string().nullable(),
	}),
	territory: z.string().nullable(),
	briefRef: briefRef.nullable(),
	/**
	 * One of the roster entry's waves, chosen at create. A start refuses
	 * while a dispatch in an earlier wave of the mission is queued or running.
	 */
	wave,
	status: dispatchStatus,
	/** Set exactly when status is halted. */
	haltReason: haltReason.nullable(),
	estimatedTokens: tokens,
	tokenSoftCeiling: tokens,
	tokenHardCeiling: tokens,
	softCeilingCrossed: z.boolean(),
	/** The runner's running count: tokensIn + tokensOut + cacheReadTokens + cacheWriteTokens. */
	tokensUsed: tokens,
	tokensIn: tokens,
	tokensOut: tokens,
	cacheReadTokens: tokens,
	cacheWriteTokens: tokens,
	/** Priced from the token split with the model's price version at start. */
	spendUsd: usd,
	wallClockMinutes: z.number().int().positive(),
	/** Frozen when the dispatch starts; null while queued. */
	agentVersionSha256: sha256.nullable(),
	/** The display id of that version, such as kel@v2; null while queued. */
	agentVersionRef: z.string().nullable(),
	skillsSha256: sha256.nullable(),
	/**
	 * The rendered brief's hash (step 9): scope, read, method and done-when,
	 * frozen at start. Null while queued, and on a dispatch started before
	 * step 9. The brief's text is read from its own route.
	 */
	briefSha256: sha256.nullable(),
	/**
	 * The commit the dispatch's room opened on (decided 2026-10-22: rooms
	 * start from finished work): the mission's base with every complete
	 * dispatch closed before the start laid onto it, in close order. Null
	 * while queued, and on a dispatch started before 2026-10-24.
	 */
	startCommitSha: commitSha.nullable(),
	/**
	 * The complete dispatches that start commit was built from, in close
	 * order; empty when it is the base. Null exactly when startCommitSha is.
	 */
	startDispatchIds: z.array(uuid).nullable(),
	model: z.string().nullable(),
	/** The harness and its version that ran the dispatch, such as claude-agent-sdk@1.2.3; null while queued. */
	harnessVersion: z.string().nullable(),
	/** The report that closed the dispatch; null until it closes. */
	reportId: uuid.nullable(),
	startedAt: iso.nullable(),
	closedAt: iso.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type Dispatch = z.infer<typeof dispatch>;

/**
 * The brief a dispatch started with (step 9), as frozen at start. Both are
 * null while queued, on a dispatch with no briefRef, and on one started
 * before step 9; when one is set, so is the other, and briefSha256 is the
 * hex SHA-256 of briefMd's UTF-8 bytes.
 */
export const dispatchBrief = z.object({
	dispatchId: uuid,
	briefSha256: sha256.nullable(),
	briefMd: z.string().nullable(),
});

export type DispatchBrief = z.infer<typeof dispatchBrief>;

export const artifactRef = z.object({ path: z.string().min(1), sha256 });

export type ArtifactRef = z.infer<typeof artifactRef>;

export const blocker = z.object({
	description: z.string().min(1),
	workaround: z.string(),
	/** The operator failed to provide something, rather than the agent failing. */
	provisioningGap: z.boolean(),
});

export type Blocker = z.infer<typeof blocker>;

/**
 * A path this report read at a hash its producer did not write. Computed by
 * the server against the producer's report; never sent by the agent.
 */
export const edgeMismatch = z.object({
	path: z.string(),
	readSha256: sha256,
	writtenSha256: sha256,
	producerDispatchId: uuid,
});

export type EdgeMismatch = z.infer<typeof edgeMismatch>;

/** Who filed a report: the agent for complete or blocked, the runner for halted or failed. */
export const reportFiledBy = z.enum(["agent", "system"]);

export type ReportFiledBy = z.infer<typeof reportFiledBy>;

/** What an agent produced and the evidence it consumed. Closes exactly one dispatch. */
export const completionReport = z.object({
	id: uuid,
	dispatchId: uuid,
	missionId: uuid,
	rosterEntryId: uuid,
	status: completionStatus,
	/** Set exactly when status is halted. */
	haltReason: haltReason.nullable(),
	softCeilingCrossed: z.boolean(),
	/** The dispatch's tokensUsed at close, set by the server. */
	actualTokens: tokens,
	agentVersionSha256: sha256,
	agentVersionRef: z.string().nullable(),
	skillsSha256: sha256,
	versionSource,
	model: z.string(),
	artifactsRead: z.array(artifactRef),
	artifactsWritten: z.array(artifactRef),
	filesTouched: tokens,
	fileTypesTouched: z.array(z.string()),
	rereads: tokens,
	blockers: z.array(blocker),
	edgeMismatches: z.array(edgeMismatch),
	filedBy: reportFiledBy,
	createdAt: iso,
});

export type CompletionReport = z.infer<typeof completionReport>;

/** Default wall clock per dispatch, in minutes (decided 2026-10-13, [hypothesis]). */
export const DEFAULT_WALL_CLOCK_MINUTES = 60;
export const MAX_WALL_CLOCK_MINUTES = 480;

/**
 * Creates a queued dispatch. Omitted estimate and ceilings come from the
 * roster entry; omitted ceilings default to 1.5× and 3× the estimate.
 * briefRef names a module of the mission's plan, and requirements that
 * module lists. wave must be one of the roster entry's waves and on in the
 * mission's playbook; omitted, it is the entry's only wave.
 */
export const createDispatchBody = z
	.object({
		rosterEntryId: uuid,
		briefRef,
		wave: wave.optional(),
		estimatedTokens: z.number().int().positive().optional(),
		tokenSoftCeiling: z.number().int().positive().optional(),
		tokenHardCeiling: z.number().int().positive().optional(),
		wallClockMinutes: z
			.number()
			.int()
			.positive()
			.max(MAX_WALL_CLOCK_MINUTES)
			.optional(),
	})
	.strict();

export type CreateDispatchBody = z.infer<typeof createDispatchBody>;

/**
 * One dispatch of an agent template (GET /api/agent-templates/:id/dispatches):
 * the Dispatch wire, the mission it ran on, and a summary of the report
 * that closed it.
 */
export const templateDispatch = dispatch.extend({
	mission: z.object({
		id: uuid,
		type: z.string(),
		sprintN: z.number().int(),
		status: missionStatus,
		origin: missionOrigin,
		/** The mission's client; null for an internal mission. */
		client: z.object({ id: uuid, name: z.string() }).nullable(),
	}),
	/** The report that closed it; null until it closes. */
	report: z
		.object({
			id: uuid,
			status: completionStatus,
			filedBy: reportFiledBy,
			actualTokens: tokens,
			/** How many blockers it lists. */
			blockers: z.number().int().nonnegative(),
			/** How many edge mismatches it records. */
			edgeMismatches: z.number().int().nonnegative(),
		})
		.nullable(),
});

export type TemplateDispatch = z.infer<typeof templateDispatch>;

export const templateDispatchListQuery = pageQuery.extend({
	status: dispatchStatus.optional(),
	missionId: uuid.optional(),
});

const statusCount = z.number().int().nonnegative();

/** Every dispatch status, zero when none. */
export const dispatchStatusCounts = z.object(
	Object.fromEntries(DISPATCH_STATUSES.map((s) => [s, statusCount])) as {
		[K in (typeof DISPATCH_STATUSES)[number]]: typeof statusCount;
	},
);

/** What the filters keep, whatever the cursor: the same on every page. */
export const templateDispatchTotals = z.object({
	total: statusCount,
	byStatus: dispatchStatusCounts,
	/** spend_usd summed as numeric in Postgres. */
	spendUsd: usd,
	tokensUsed: tokens,
	estimatedTokens: tokens,
});

export const templateDispatchListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(templateDispatch),
	meta: pageMeta.extend({ totals: templateDispatchTotals }),
});

export const dispatchListQuery = pageQuery.extend({
	status: dispatchStatus.optional(),
	rosterEntryId: uuid.optional(),
});

const byId = z.object({ id: uuid });

/**
 * A start's answer. earlierWaveBlocked is a warning, not a refusal: the
 * blocked dispatches in earlier waves of the mission, oldest first, empty
 * when there are none.
 */
export const startDispatchEnvelope = z.object({
	success: z.literal(true),
	data: dispatch,
	meta: z.object({ earlierWaveBlocked: z.array(uuid) }),
});

export const dispatchContract = c.router({
	list: {
		method: "GET",
		path: "/api/missions/:id/dispatches",
		pathParams: byId,
		query: dispatchListQuery,
		responses: { 200: pageEnvelope(dispatch) },
		summary: "A mission's dispatches, newest first",
	},
	get: {
		method: "GET",
		path: "/api/dispatches/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(dispatch) },
	},
	brief: {
		method: "GET",
		path: "/api/dispatches/:id/brief",
		pathParams: byId,
		responses: { 200: successEnvelope(dispatchBrief) },
		summary:
			"The brief the dispatch started with: scope, read, method, done when",
	},
	steps: {
		method: "GET",
		path: "/api/dispatches/:id/steps",
		pathParams: byId,
		query: runStepsQuery,
		responses: { 200: runStepsEnvelope },
		summary:
			"The run's steps in seq order, the same shape as a Canon session's; written on the runner's tick",
	},
	create: {
		method: "POST",
		path: "/api/missions/:id/dispatches",
		pathParams: byId,
		headers: idempotencyHeaders,
		body: createDispatchBody,
		/** 201 created; 200 with Idempotency-Replayed: true for a replay. */
		responses: {
			201: successEnvelope(dispatch),
			200: successEnvelope(dispatch),
		},
		summary: "Queue a dispatch of one active roster entry",
	},
	start: {
		method: "POST",
		path: "/api/dispatches/:id/start",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: startDispatchEnvelope },
		summary:
			"queued → running: freezes the identity, skills, model and price version, and hands the token to the harness",
	},
	halt: {
		method: "POST",
		path: "/api/dispatches/:id/halt",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(dispatch) },
		summary:
			"running → halted (operator); the runner files the report and the token dies",
	},
	reports: {
		method: "GET",
		path: "/api/missions/:id/completion-reports",
		pathParams: byId,
		query: pageQuery,
		responses: { 200: pageEnvelope(completionReport) },
		summary: "A mission's completion reports, newest first",
	},
	report: {
		method: "GET",
		path: "/api/completion-reports/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(completionReport) },
	},
});
