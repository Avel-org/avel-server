import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { activityActor } from "./activity";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";
import { oneOrMany } from "./shared/query";

const c = initContract();
const uuid = z.string().uuid();
const iso = z.string().datetime();

/**
 * Canon, the project briefer (DATA-CONTRACTS-V2, *Canon's entities*). It
 * drafts; the operator decides. Every route runs under the client scope of
 * the intake or client it names; an id another client owns answers 404.
 */

// The value lists a client renders. The database pgEnums are built from
// these (src/db/schema/canon.ts), so the two cannot drift.
export const CANON_SESSION_STATUSES = ["open", "closed", "halted"] as const;
export const CANON_MESSAGE_ROLES = ["operator", "canon"] as const;
export const CANON_QUESTION_STATUSES = [
	"open",
	"answered",
	"acknowledged",
	"dismissed",
] as const;
export const CLIENT_MEMORY_STATUSES = ["proposed", "kept", "removed"] as const;

/**
 * Why a session halted, as the wire shows it. The database enum also holds
 * spend_ceiling, which nothing writes for Canon and a CHECK refuses.
 */
export const CANON_HALT_REASONS = ["token_hard_ceiling", "operator"] as const;

export const canonSessionStatus = z.enum(CANON_SESSION_STATUSES);
export const canonMessageRole = z.enum(CANON_MESSAGE_ROLES);
export const canonQuestionStatus = z.enum(CANON_QUESTION_STATUSES);
export const clientMemoryStatus = z.enum(CLIENT_MEMORY_STATUSES);

/** The Idempotency-Key header, optional here: without one, a retry is a new request. */
export const optionalIdempotencyHeaders = z.object({
	"idempotency-key": z.string().uuid().optional(),
});

/** `<file sha256>:<first line>-<last line>`: one passage of one file. */
export const chunkId = z
	.string()
	.regex(/^[0-9a-f]{64}:[1-9][0-9]*-[1-9][0-9]*$/);

/** The file a chunk is from, resolved by its hash against the intake's files. */
const chunkSource = z.object({
	fileId: uuid,
	fileName: z.string(),
	/** The bytes are destroyed; the passage can no longer be opened. */
	purged: z.boolean(),
	chunkId,
});

/** A passage Canon's text quotes, with the heading path stored beside it. */
export const canonCitation = chunkSource.extend({
	/** The heading path above the passage, outermost first. */
	heading: z.array(z.string()),
	quote: z.string(),
});

export type CanonCitation = z.infer<typeof canonCitation>;

export const canonSession = z.object({
	id: uuid,
	intakeId: uuid,
	status: canonSessionStatus,
	/** Set exactly when status is halted. */
	haltReason: z.enum(CANON_HALT_REASONS).nullable(),
	model: z.string(),
	estimatedTokens: z.number().int().positive(),
	tokenSoftCeiling: z.number().int().positive(),
	tokenHardCeiling: z.number().int().positive(),
	tokensUsed: z.number().int().nonnegative(),
	spendUsd: z.number().nonnegative(),
	/** Whose move it is: "canon" while Canon is replying, else "idle". */
	turn: z.enum(["idle", "canon"]),
	/** The highest message seq; 0 before the first message. */
	lastSeq: z.number().int().nonnegative(),
	/** The intake's questions this session asked that are still open. */
	openQuestions: z.number().int().nonnegative(),
	openedBy: activityActor,
	openedAt: iso,
	closedAt: iso.nullable(),
});

export type CanonSession = z.infer<typeof canonSession>;

export const canonMessage = z.object({
	id: uuid,
	/** The order, from 1; never the timestamp. */
	seq: z.number().int().positive(),
	role: canonMessageRole,
	contentMd: z.string(),
	/** What Canon's text rests on; empty for the operator. */
	citations: z.array(canonCitation),
	createdAt: iso,
});

export type CanonMessage = z.infer<typeof canonMessage>;

const questionOption = z.object({
	label: z.string(),
	description: z.string(),
});

export const canonAnswer = z.object({
	selected: z.array(z.string()),
	other: z.string().nullable(),
});

export const canonQuestion = z.object({
	id: uuid,
	intakeId: uuid,
	canonSessionId: uuid,
	/** At most 12 characters. */
	header: z.string(),
	question: z.string(),
	/** Two to four. Free text ("other") is always allowed besides. */
	options: z.array(questionOption),
	multiSelect: z.boolean(),
	/** Why Canon asks: what it could not decide, and from what. */
	reason: z.string(),
	/** The passages that raised it. May be empty. */
	sources: z.array(chunkSource),
	status: canonQuestionStatus,
	/** Set when answered. */
	answer: canonAnswer.nullable(),
	/** What the answer changed in the draft. */
	effectMd: z.string().nullable(),
	/** Set exactly when status is not open. */
	decidedBy: activityActor.nullable(),
	decidedAt: iso.nullable(),
	createdAt: iso,
});

export type CanonQuestion = z.infer<typeof canonQuestion>;

export const clientMemory = z.object({
	id: uuid,
	clientId: uuid,
	contentMd: z.string(),
	status: clientMemoryStatus,
	/** Canon, when a session proposed it; null when the operator wrote it. */
	proposedBy: activityActor.nullable(),
	decidedBy: activityActor.nullable(),
	decidedAt: iso.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type ClientMemory = z.infer<typeof clientMemory>;

const contentMd = z.string().trim().min(1).max(20_000);

/** Omitted ceilings follow the estimate: soft 1.5x, hard 3x, as on a dispatch. */
export const openCanonSessionBody = z
	.object({
		estimatedTokens: z.number().int().positive().max(10_000_000).optional(),
		tokenSoftCeiling: z.number().int().positive().max(10_000_000).optional(),
		tokenHardCeiling: z.number().int().positive().max(10_000_000).optional(),
	})
	.strict();

export const postCanonMessageBody = z.object({ contentMd }).strict();

export const answerCanonQuestionBody = z
	.object({
		selected: z.array(z.string().max(200)).max(4),
		other: z.string().max(2_000).optional(),
		effectMd: z.string().trim().min(1).max(20_000).optional(),
	})
	.strict();

export const decideCanonQuestionBody = z
	.object({ effectMd: z.string().trim().min(1).max(20_000).optional() })
	.strict();

export const writeClientMemoryBody = z.object({ contentMd }).strict();

const byId = z.object({ id: uuid });

const listEnvelope = <T extends z.ZodTypeAny>(item: T) =>
	z.object({
		success: z.literal(true),
		data: z.array(item),
		meta: pageMeta.extend({ total: z.number().int().nonnegative() }),
	});

export const canonQuestionCounts = z.object({
	open: z.number().int().nonnegative(),
	answered: z.number().int().nonnegative(),
	acknowledged: z.number().int().nonnegative(),
	dismissed: z.number().int().nonnegative(),
});

export const canonContract = c.router({
	openSession: {
		method: "POST",
		path: "/api/intakes/:id/canon-sessions",
		pathParams: byId,
		headers: optionalIdempotencyHeaders,
		body: openCanonSessionBody,
		/** 201 opened; 200 with Idempotency-Replayed: true for a replay. */
		responses: {
			201: successEnvelope(canonSession),
			200: successEnvelope(canonSession),
		},
		summary: "Open a Canon session on a draft intake: one open at a time",
	},
	listSessions: {
		method: "GET",
		path: "/api/intakes/:id/canon-sessions",
		pathParams: byId,
		query: pageQuery,
		responses: { 200: listEnvelope(canonSession) },
		summary: "The intake's Canon sessions, newest first",
	},
	getSession: {
		method: "GET",
		path: "/api/canon-sessions/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(canonSession) },
		summary: "One Canon session",
	},
	closeSession: {
		method: "POST",
		path: "/api/canon-sessions/:id/close",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(canonSession) },
		summary: "Close an open session, between Canon's turns",
	},
	haltSession: {
		method: "POST",
		path: "/api/canon-sessions/:id/halt",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(canonSession) },
		summary: "Halt an open session, mid-turn included",
	},
	listMessages: {
		method: "GET",
		path: "/api/canon-sessions/:id/messages",
		pathParams: byId,
		query: z.object({
			/** Only messages after this seq: 0 or omitted for all. */
			afterSeq: z.coerce.number().int().nonnegative().default(0),
			limit: z.coerce.number().int().min(1).max(200).default(100),
		}),
		responses: {
			200: z.object({
				success: z.literal(true),
				data: z.array(canonMessage),
				meta: z.object({
					/** The session's highest seq, so a client knows if more remain. */
					lastSeq: z.number().int().nonnegative(),
				}),
			}),
		},
		summary: "The session's messages in seq order",
	},
	postMessage: {
		method: "POST",
		path: "/api/canon-sessions/:id/messages",
		pathParams: byId,
		headers: optionalIdempotencyHeaders,
		body: postCanonMessageBody,
		/**
		 * 202: the operator's message is stored and Canon's turn has started;
		 * the reply arrives as a later message. 200 with Idempotency-Replayed:
		 * true for a replay.
		 */
		responses: {
			202: successEnvelope(canonMessage),
			200: successEnvelope(canonMessage),
		},
		summary: "Send Canon the operator's message",
	},
	listQuestions: {
		method: "GET",
		path: "/api/intakes/:id/canon-questions",
		pathParams: byId,
		query: pageQuery.extend({
			status: oneOrMany(canonQuestionStatus).optional(),
		}),
		responses: {
			200: z.object({
				success: z.literal(true),
				data: z.array(canonQuestion),
				meta: pageMeta.extend({
					total: z.number().int().nonnegative(),
					/** Every status's count for the intake, ignoring the status filter. */
					counts: canonQuestionCounts,
				}),
			}),
		},
		summary: "The intake's Canon questions, oldest first",
	},
	answerQuestion: {
		method: "POST",
		path: "/api/canon-questions/:id/answer",
		pathParams: byId,
		body: answerCanonQuestionBody,
		responses: { 200: successEnvelope(canonQuestion) },
		summary: "Answer an open question",
	},
	acknowledgeQuestion: {
		method: "POST",
		path: "/api/canon-questions/:id/acknowledge",
		pathParams: byId,
		body: decideCanonQuestionBody,
		responses: { 200: successEnvelope(canonQuestion) },
		summary: "Acknowledge an open question without answering it",
	},
	dismissQuestion: {
		method: "POST",
		path: "/api/canon-questions/:id/dismiss",
		pathParams: byId,
		body: decideCanonQuestionBody,
		responses: { 200: successEnvelope(canonQuestion) },
		summary: "Dismiss an open question",
	},
	listMemory: {
		method: "GET",
		path: "/api/clients/:id/memory",
		pathParams: byId,
		query: pageQuery.extend({
			status: oneOrMany(clientMemoryStatus).optional(),
		}),
		responses: { 200: listEnvelope(clientMemory) },
		summary: "The client's project memory, newest first",
	},
	writeMemory: {
		method: "POST",
		path: "/api/clients/:id/memory",
		pathParams: byId,
		body: writeClientMemoryBody,
		responses: { 201: successEnvelope(clientMemory) },
		summary: "Write a memory the operator keeps",
	},
	keepMemory: {
		method: "POST",
		path: "/api/client-memory/:id/keep",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(clientMemory) },
		summary: "Keep a memory Canon proposed",
	},
	removeMemory: {
		method: "POST",
		path: "/api/client-memory/:id/remove",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(clientMemory) },
		summary: "Remove a proposed or kept memory",
	},
	editMemory: {
		method: "PATCH",
		path: "/api/client-memory/:id",
		pathParams: byId,
		body: writeClientMemoryBody,
		responses: { 200: successEnvelope(clientMemory) },
		summary: "Edit a proposed or kept memory",
	},
});
