import { z } from "zod";
import {
	completionStatus,
	dispatchStatus,
	haltReason,
	versionSource,
} from "./shared/status";

/**
 * Module 6 wire shapes (DATA-CONTRACTS-V2, Dispatch and CompletionReport).
 * The routes that answer with them arrive in later steps of the unit.
 */

const iso = z.string().datetime();
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
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
	model: z.string().nullable(),
	/** The report that closed the dispatch; null until it closes. */
	reportId: uuid.nullable(),
	startedAt: iso.nullable(),
	closedAt: iso.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type Dispatch = z.infer<typeof dispatch>;

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
