import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { activityActor } from "./activity";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";
import { oneOrMany } from "./shared/query";
import {
	RUN_STEP_KINDS,
	runStepsEnvelope,
	runStepsQuery,
} from "./shared/run-step";

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
 * Where a session lives (J, 2026-10-20). An open session has no client,
 * engagement or intake, and reads no client's data; a client session
 * carries its client and, optionally, an engagement and an intake.
 */
export const CANON_SCOPES = ["open", "client"] as const;

/**
 * What a message asks of Canon, and so which tools the turn gets: ask reads
 * only what is in the prompt, fetch reads the command center's own data,
 * draft writes the intake's brief, questions and roster. "act" comes with
 * module 14.
 */
export const CANON_MODES = ["ask", "fetch", "draft"] as const;

/** Who named the session. Canon never renames one the operator named. */
export const CANON_TITLE_SOURCES = ["canon", "operator"] as const;

/**
 * One step of a turn, as the run trace shows it. reasoning_summary is the
 * summary the API returns, never raw reasoning. text is a chunk of the
 * reply as it is written; the reply itself is stored once, as a message.
 */
export const CANON_STEP_KINDS = RUN_STEP_KINDS;

/**
 * Why a session halted, as the wire shows it. The database enum also holds
 * spend_ceiling, which nothing writes for Canon and a CHECK refuses.
 */
export const CANON_HALT_REASONS = ["token_hard_ceiling", "operator"] as const;

export const canonSessionStatus = z.enum(CANON_SESSION_STATUSES);
export const canonMessageRole = z.enum(CANON_MESSAGE_ROLES);
export const canonQuestionStatus = z.enum(CANON_QUESTION_STATUSES);
export const clientMemoryStatus = z.enum(CLIENT_MEMORY_STATUSES);
export const canonScope = z.enum(CANON_SCOPES);
export const canonMode = z.enum(CANON_MODES);
export const canonTitleSource = z.enum(CANON_TITLE_SOURCES);
export const canonStepKind = z.enum(CANON_STEP_KINDS);

export type CanonMode = z.infer<typeof canonMode>;

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

const partValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * One structured piece of a message, rendered as a card or a table. Fetch
 * mode writes these from the command center's rows; contentMd stays the
 * plain-text rendering beside them.
 */
export const canonPart = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), md: z.string() }).strict(),
	z
		.object({
			type: z.literal("entity"),
			/** An entity type the activity log knows, such as "mission". */
			entityType: z.string().min(1).max(64),
			id: uuid,
			fields: z.record(z.string(), partValue),
		})
		.strict(),
	z
		.object({
			type: z.literal("table"),
			columns: z
				.array(z.object({ key: z.string(), label: z.string() }).strict())
				.max(20),
			rows: z.array(z.record(z.string(), partValue)).max(200),
		})
		.strict(),
]);

export type CanonPart = z.infer<typeof canonPart>;

export const canonSession = z.object({
	id: uuid,
	scope: canonScope,
	/** Null exactly when scope is open. */
	clientId: uuid.nullable(),
	engagementId: uuid.nullable(),
	/** Set for a session that briefs one intake; draft mode needs one. */
	intakeId: uuid.nullable(),
	/** Null until Canon names it after the first exchange, or the operator does. */
	title: z.string().nullable(),
	titleSetBy: canonTitleSource.nullable(),
	/** The default mode; each message records the mode it was sent in. */
	mode: canonMode,
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
	/** Set while archived: hidden from the default list. Never while open. */
	archivedAt: iso.nullable(),
	/** The list's sort: the latest open, reopen or message. */
	lastActivityAt: iso,
});

export type CanonSession = z.infer<typeof canonSession>;

/**
 * One row of the session list, which crosses clients. A summary only: the
 * list reads it through one SECURITY DEFINER function (drizzle/0042), and
 * GET /api/canon-sessions/:id serves the rest.
 */
export const canonSessionListItem = canonSession.pick({
	id: true,
	scope: true,
	clientId: true,
	engagementId: true,
	intakeId: true,
	title: true,
	mode: true,
	status: true,
	haltReason: true,
	turn: true,
	openedAt: true,
	archivedAt: true,
	lastActivityAt: true,
});

export type CanonSessionListItem = z.infer<typeof canonSessionListItem>;

export const canonMessage = z.object({
	id: uuid,
	/** The order, from 1; never the timestamp. */
	seq: z.number().int().positive(),
	role: canonMessageRole,
	/** The mode it was sent in; for Canon, the mode its turn ran in. */
	mode: canonMode,
	contentMd: z.string(),
	/** What Canon's text rests on; empty for the operator. */
	citations: z.array(canonCitation),
	/** Cards and tables beside contentMd; empty for the operator. */
	parts: z.array(canonPart),
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

/** mode defaults to the session's. */
export const postCanonMessageBody = z
	.object({ contentMd, mode: canonMode.optional() })
	.strict();

const ceilings = {
	estimatedTokens: z.number().int().positive().max(10_000_000).optional(),
	tokenSoftCeiling: z.number().int().positive().max(10_000_000).optional(),
	tokenHardCeiling: z.number().int().positive().max(10_000_000).optional(),
};

/**
 * An open session reads no client's data, so it has no ids and no draft
 * mode. A client session names its client, and optionally an engagement of
 * that client and a draft intake of that engagement; mode defaults to draft
 * with an intake, ask without. Omitted ceilings follow the estimate.
 */
export const createCanonSessionBody = z.discriminatedUnion("scope", [
	z
		.object({
			scope: z.literal("open"),
			mode: z.enum(["ask", "fetch"]).optional(),
			...ceilings,
		})
		.strict(),
	z
		.object({
			scope: z.literal("client"),
			clientId: uuid,
			engagementId: uuid.optional(),
			intakeId: uuid.optional(),
			mode: canonMode.optional(),
			...ceilings,
		})
		.strict(),
]);

/** Any subset, at least one. A title the operator sets is never renamed by Canon. */
export const updateCanonSessionBody = z
	.object({
		title: z.string().trim().min(1).max(120),
		mode: canonMode,
	})
	.partial()
	.strict()
	.refine((b) => Object.keys(b).length > 0, {
		message: "Give at least one field to change",
	});

export const listCanonSessionsQuery = pageQuery.extend({
	scope: canonScope.optional(),
	clientId: uuid.optional(),
	status: oneOrMany(canonSessionStatus).optional(),
	/** false (the default) hides archived sessions; true shows only them. */
	archived: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),
	/** Matched against the title, case-insensitively. */
	q: z.string().trim().min(1).max(200).optional(),
});

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
	createSession: {
		method: "POST",
		path: "/api/canon-sessions",
		body: createCanonSessionBody,
		responses: { 201: successEnvelope(canonSession) },
		summary:
			"Open a session: open scope (no client), or a client's, optionally on an engagement and a draft intake",
	},
	listAllSessions: {
		method: "GET",
		path: "/api/canon-sessions",
		query: listCanonSessionsQuery,
		responses: { 200: listEnvelope(canonSessionListItem) },
		summary:
			"Every Canon session, open and client, newest activity first; archived only when asked",
	},
	updateSession: {
		method: "PATCH",
		path: "/api/canon-sessions/:id",
		pathParams: byId,
		body: updateCanonSessionBody,
		responses: { 200: successEnvelope(canonSession) },
		summary:
			"Rename a session, or change its default mode while open (draft needs an intake: canon_mode_unavailable)",
	},
	reopenSession: {
		method: "POST",
		path: "/api/canon-sessions/:id/reopen",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(canonSession) },
		summary:
			"Closed, or halted by the operator, back to open, archive cleared. A token-ceiling halt is final (canon_session_final)",
	},
	archiveSession: {
		method: "POST",
		path: "/api/canon-sessions/:id/archive",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(canonSession) },
		summary: "Archive a session, closing it first when open",
	},
	unarchiveSession: {
		method: "POST",
		path: "/api/canon-sessions/:id/unarchive",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(canonSession) },
		summary:
			"Show an archived session in the default list again; it stays closed",
	},
	listSteps: {
		method: "GET",
		path: "/api/canon-sessions/:id/steps",
		pathParams: byId,
		query: runStepsQuery,
		responses: { 200: runStepsEnvelope },
		summary: "The session's steps in seq order, written as each turn runs",
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
