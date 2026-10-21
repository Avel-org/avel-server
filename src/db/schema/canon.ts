import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	type PgTableExtraConfigValue,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import {
	CANON_MESSAGE_ROLES,
	CANON_MODES,
	CANON_QUESTION_STATUSES,
	CANON_SCOPES,
	CANON_SESSION_STATUSES,
	CANON_STEP_KINDS,
	CANON_TITLE_SOURCES,
	type CanonPart,
	CLIENT_MEMORY_STATUSES,
} from "../../contract/canon";
import { client, engagement } from "./agency";
import { user } from "./auth";
import { id, timestamps } from "./columns";
import { intake } from "./delivery";
import { agentIdentityVersion } from "./work";

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

// Built from the contract's lists, so the database and avel-web cannot drift.
export const canonSessionStatus = pgEnum(
	"canon_session_status",
	CANON_SESSION_STATUSES,
);
export const canonHaltReason = pgEnum("canon_halt_reason", [
	"token_hard_ceiling",
	"spend_ceiling",
	"operator",
]);
export const canonMessageRole = pgEnum(
	"canon_message_role",
	CANON_MESSAGE_ROLES,
);
export const canonQuestionStatus = pgEnum(
	"canon_question_status",
	CANON_QUESTION_STATUSES,
);
export const clientMemoryStatus = pgEnum(
	"client_memory_status",
	CLIENT_MEMORY_STATUSES,
);
export const canonScope = pgEnum("canon_scope", CANON_SCOPES);
export const canonMode = pgEnum("canon_mode", CANON_MODES);
export const canonTitleSource = pgEnum(
	"canon_title_source",
	CANON_TITLE_SOURCES,
);
export const canonStepKind = pgEnum("canon_step_kind", CANON_STEP_KINDS);

/**
 * client_id, or the zero uuid for an open session's rows: a NOT NULL key the
 * children's composite foreign keys can match on. A composite key with a
 * NULL in it is not checked at all (MATCH SIMPLE), so client_id alone would
 * let an open row hang off a client's session.
 */
const scopeKey = () =>
	uuid("scope_key")
		.notNull()
		.generatedAlwaysAs(
			sql`coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
		);

/**
 * What Canon's text rests on, as stored: the chunk (`<file sha256>:<first
 * line>-<last line>`), its heading path and the quoted text. The server
 * resolves the file from the chunk's hash against the intake's files; no file
 * id is stored (BE Main, 2026-10-19). Zod checks it where the harness writes it.
 */
export interface Citation {
	chunkId: string;
	heading: string[];
	quote: string;
}

export interface QuestionOption {
	label: string;
	description: string;
}

export interface QuestionAnswer {
	selected: string[];
	other?: string;
}

/*
 * Canon's entities (DATA-CONTRACTS-V2, *Canon's entities*). Every table
 * carries client_id, set by the server from the intake's engagement, and is
 * under row-level security keyed on it (drizzle/0030_canon.sql): a write must
 * name exactly the transaction's client (withClientScope), and a read sees
 * only that client's rows. Composite foreign keys tie each row's client_id
 * to its parent's, so no row can hang off another client's session.
 */

/**
 * One briefing conversation on one Intake, with the bounds a dispatch has.
 * No deleted_at: a session is evidence. engagement_id is not in the spec's
 * list; it is the link that lets a foreign key prove client_id is the
 * intake's client (intake → engagement → client).
 */
export const canonSession = pgTable(
	"canon_session",
	{
		...id,
		// open: all three null. client: client_id set, and an engagement and
		// an intake optionally (J, 2026-10-20). A CHECK holds the shapes.
		scope: canonScope("scope").notNull(),
		intakeId: uuid("intake_id").references((): AnyPgColumn => intake.id),
		engagementId: uuid("engagement_id").references(() => engagement.id),
		clientId: uuid("client_id").references(() => client.id),
		scopeKey: scopeKey(),
		status: canonSessionStatus("status").notNull(),
		/** The default mode; every message records its own. */
		mode: canonMode("mode").notNull(),
		title: text("title"),
		titleSetBy: canonTitleSource("title_set_by"),
		/** Hidden from the default list, still searchable; never while open. */
		archivedAt: at("archived_at"),
		/** The list's sort: set at open, reopen, and each message. */
		lastActivityAt: at("last_activity_at").notNull(),
		haltReason: canonHaltReason("halt_reason"),
		agentIdentityVersionId: uuid("agent_identity_version_id")
			.notNull()
			.references(() => agentIdentityVersion.id),
		model: text("model").notNull(),
		priceVersion: text("price_version").notNull(),
		harnessVersion: text("harness_version").notNull(),
		estimatedTokens: integer("estimated_tokens").notNull(),
		tokenSoftCeiling: integer("token_soft_ceiling").notNull(),
		tokenHardCeiling: integer("token_hard_ceiling").notNull(),
		// Written only by the server; always the sum of the four splits.
		tokensUsed: integer("tokens_used").notNull(),
		tokensIn: integer("tokens_in").notNull(),
		tokensOut: integer("tokens_out").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		spendUsd: numeric("spend_usd", { precision: 14, scale: 6 }).notNull(),
		openedBy: uuid("opened_by")
			.notNull()
			.references(() => user.id),
		openedAt: at("opened_at").notNull(),
		closedAt: at("closed_at"),
		// Set when the operator's message starts Canon's turn, cleared when
		// the turn ends (a reply, a question, an error, a halt) or when
		// sweepStuckCanonTurns finds it stuck. The wire's turn is "canon"
		// exactly while it is set.
		turnStartedAt: at("turn_started_at"),
		// The open request's Idempotency-Key, scoped to the intake, and the
		// hash of its body; set together or not at all, as on dispatch.
		idempotencyKey: text("idempotency_key"),
		requestSha256: text("request_sha256"),
		...timestamps,
	},
	// Annotated: intake and canon_session reference each other, and the
	// inferred types would be circular.
	(t): PgTableExtraConfigValue[] => [
		index("canon_session_intake_id_idx").on(t.intakeId),
		index("canon_session_client_id_idx").on(t.clientId),
		// One open session per intake, held by the database: a second open
		// loses the race here, not in application code.
		uniqueIndex("canon_session_one_open_per_intake")
			.on(t.intakeId)
			.where(sql`status = 'open'`),
		uniqueIndex("canon_session_intake_idempotency_key_uq")
			.on(t.intakeId, t.idempotencyKey)
			.where(sql`idempotency_key is not null`),
		// The targets of the children's composite foreign keys.
		uniqueIndex("canon_session_id_client_id_uq").on(t.id, t.clientId),
		// The target of the message and step foreign keys, open rows included.
		uniqueIndex("canon_session_id_scope_key_uq").on(t.id, t.scopeKey),
		index("canon_session_last_activity_idx").on(t.lastActivityAt, t.id),
		// The target of intake_drafted_by_canon_session_fk.
		uniqueIndex("canon_session_id_intake_id_uq").on(t.id, t.intakeId),
		uniqueIndex("canon_session_id_intake_id_client_id_uq").on(
			t.id,
			t.intakeId,
			t.clientId,
		),
		foreignKey({
			name: "canon_session_intake_engagement_fk",
			columns: [t.intakeId, t.engagementId],
			foreignColumns: [intake.id, intake.engagementId],
		}),
		foreignKey({
			name: "canon_session_engagement_client_fk",
			columns: [t.engagementId, t.clientId],
			foreignColumns: [engagement.id, engagement.clientId],
		}),
		check(
			"canon_session_halt_reason_iff_halted",
			sql`(${t.status} = 'halted') = (${t.haltReason} is not null)`,
		),
		check("canon_session_estimate_positive", sql`${t.estimatedTokens} > 0`),
		check(
			"canon_session_soft_ceiling_at_least_estimate",
			sql`${t.tokenSoftCeiling} >= ${t.estimatedTokens}`,
		),
		check(
			"canon_session_hard_ceiling_at_least_soft",
			sql`${t.tokenHardCeiling} >= ${t.tokenSoftCeiling}`,
		),
		check(
			"canon_session_token_split_nonnegative",
			sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`,
		),
		check(
			"canon_session_tokens_used_is_split_sum",
			sql`${t.tokensUsed} = ${t.tokensIn} + ${t.tokensOut} + ${t.cacheReadTokens} + ${t.cacheWriteTokens}`,
		),
		check("canon_session_spend_nonnegative", sql`${t.spendUsd} >= 0`),
		check(
			"canon_session_closed_iff_ended",
			sql`(${t.status} <> 'open') = (${t.closedAt} is not null)`,
		),
		check(
			"canon_session_turn_only_open",
			sql`${t.turnStartedAt} is null or ${t.status} = 'open'`,
		),
		// The spec's halt reasons include spend_ceiling, but nothing writes it
		// for Canon (BE Main, 2026-10-19), so the database refuses it.
		check(
			"canon_session_no_spend_ceiling",
			sql`${t.haltReason} is null or ${t.haltReason} <> 'spend_ceiling'`,
		),
		check(
			"canon_session_idempotency_complete",
			sql`(${t.idempotencyKey} is null) = (${t.requestSha256} is null)`,
		),
		check(
			"canon_session_request_sha256_hex",
			sql`${t.requestSha256} is null or ${t.requestSha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"canon_session_closed_after_opened",
			sql`${t.closedAt} is null or ${t.closedAt} >= ${t.openedAt}`,
		),
		check(
			"canon_session_scope_shape",
			sql`case ${t.scope} when 'open' then ${t.clientId} is null and ${t.engagementId} is null and ${t.intakeId} is null else ${t.clientId} is not null end`,
		),
		// The intake's foreign key carries its engagement, and a composite key
		// with a NULL in it is not checked.
		check(
			"canon_session_intake_needs_engagement",
			sql`${t.intakeId} is null or ${t.engagementId} is not null`,
		),
		check(
			"canon_session_draft_needs_intake",
			sql`${t.mode} <> 'draft' or ${t.intakeId} is not null`,
		),
		check(
			"canon_session_title_set_together",
			sql`(${t.title} is null) = (${t.titleSetBy} is null)`,
		),
		check(
			"canon_session_title_length",
			sql`${t.title} is null or char_length(btrim(${t.title})) between 1 and 120`,
		),
		check(
			"canon_session_archived_not_open",
			sql`${t.archivedAt} is null or ${t.status} <> 'open'`,
		),
	],
);

/**
 * One turn of the conversation. Append-only: a trigger refuses UPDATE,
 * DELETE and TRUNCATE, and avel_app holds neither UPDATE nor DELETE. seq is
 * the order, never the timestamp.
 */
export const canonMessage = pgTable(
	"canon_message",
	{
		...id,
		canonSessionId: uuid("canon_session_id")
			.notNull()
			.references(() => canonSession.id),
		// The session's client; null in an open session.
		clientId: uuid("client_id").references(() => client.id),
		scopeKey: scopeKey(),
		seq: integer("seq").notNull(),
		role: canonMessageRole("role").notNull(),
		/** The mode it was sent in, or the turn ran in for Canon's reply. */
		mode: canonMode("mode").notNull(),
		contentMd: text("content_md").notNull(),
		citations: jsonb("citations").$type<Citation[]>().notNull(),
		/** Cards and tables beside contentMd; empty for the operator. */
		parts: jsonb("parts").$type<CanonPart[]>().notNull(),
		// An operator's post's Idempotency-Key, scoped to the session, and the
		// hash of its body. Canon's own messages carry none.
		idempotencyKey: text("idempotency_key"),
		requestSha256: text("request_sha256"),
		createdAt: at("created_at").notNull(),
	},
	(t) => [
		uniqueIndex("canon_message_session_seq_uq").on(t.canonSessionId, t.seq),
		uniqueIndex("canon_message_session_idempotency_key_uq")
			.on(t.canonSessionId, t.idempotencyKey)
			.where(sql`idempotency_key is not null`),
		check(
			"canon_message_idempotency_complete",
			sql`(${t.idempotencyKey} is null) = (${t.requestSha256} is null)`,
		),
		check(
			"canon_message_request_sha256_hex",
			sql`${t.requestSha256} is null or ${t.requestSha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"canon_message_key_only_operator",
			sql`${t.idempotencyKey} is null or ${t.role} = 'operator'`,
		),
		index("canon_message_client_id_idx").on(t.clientId),
		foreignKey({
			name: "canon_message_session_scope_fk",
			columns: [t.canonSessionId, t.scopeKey],
			foreignColumns: [canonSession.id, canonSession.scopeKey],
		}),
		check(
			"canon_message_citations_array",
			sql`jsonb_typeof(${t.citations}) = 'array'`,
		),
		check("canon_message_parts_array", sql`jsonb_typeof(${t.parts}) = 'array'`),
		check(
			"canon_message_operator_has_no_parts",
			sql`${t.role} <> 'operator' or ${t.parts} = '[]'::jsonb`,
		),
		check(
			"canon_message_operator_cites_nothing",
			sql`${t.role} <> 'operator' or ${t.citations} = '[]'::jsonb`,
		),
	],
);

/**
 * One step of a turn, written as the turn runs so the operator can watch it
 * (J, 2026-10-20: polled after a seq, as messages are). Append-only, as
 * messages are: a tool call and its result are two rows, never one updated.
 * turn is the seq of the operator message that started the turn.
 */
export const canonStep = pgTable(
	"canon_step",
	{
		...id,
		canonSessionId: uuid("canon_session_id")
			.notNull()
			.references(() => canonSession.id),
		clientId: uuid("client_id").references(() => client.id),
		scopeKey: scopeKey(),
		turn: integer("turn").notNull(),
		seq: integer("seq").notNull(),
		kind: canonStepKind("kind").notNull(),
		/** Short and human, for the trace's row. */
		label: text("label").notNull(),
		detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
		startedAt: at("started_at").notNull(),
		endedAt: at("ended_at"),
		tokensIn: integer("tokens_in"),
		tokensOut: integer("tokens_out"),
		createdAt: at("created_at").notNull(),
	},
	(t) => [
		uniqueIndex("canon_step_session_seq_uq").on(t.canonSessionId, t.seq),
		index("canon_step_client_id_idx").on(t.clientId),
		foreignKey({
			name: "canon_step_session_scope_fk",
			columns: [t.canonSessionId, t.scopeKey],
			foreignColumns: [canonSession.id, canonSession.scopeKey],
		}),
		check("canon_step_turn_positive", sql`${t.turn} >= 1`),
		check("canon_step_seq_positive", sql`${t.seq} >= 1`),
		check(
			"canon_step_label_length",
			sql`char_length(btrim(${t.label})) between 1 and 80`,
		),
		check(
			"canon_step_detail_object",
			sql`jsonb_typeof(${t.detail}) = 'object'`,
		),
		check(
			"canon_step_ended_after_started",
			sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`,
		),
		check(
			"canon_step_tokens_nonnegative",
			sql`(${t.tokensIn} is null or ${t.tokensIn} >= 0) and (${t.tokensOut} is null or ${t.tokensOut} >= 0)`,
		),
	],
);

/**
 * A question Canon asks when it cannot decide from the documents. It belongs
 * to the Intake and outlives the session; an open one blocks approval.
 */
export const canonQuestion = pgTable(
	"canon_question",
	{
		...id,
		intakeId: uuid("intake_id")
			.notNull()
			.references(() => intake.id),
		canonSessionId: uuid("canon_session_id")
			.notNull()
			.references(() => canonSession.id),
		clientId: uuid("client_id")
			.notNull()
			.references(() => client.id),
		header: text("header").notNull(),
		question: text("question").notNull(),
		options: jsonb("options").$type<QuestionOption[]>().notNull(),
		multiSelect: boolean("multi_select").notNull(),
		reason: text("reason").notNull(),
		// The passages that raised it: `<file sha256>:<first line>-<last line>`.
		// A file id lost the passage, and the passage is the point (BE Main,
		// 2026-10-19). May be empty. The harness's Zod schema is the stricter gate.
		sourceChunkIds: text("source_chunk_ids").array().notNull(),
		status: canonQuestionStatus("status").notNull(),
		answer: jsonb("answer").$type<QuestionAnswer>(),
		effectMd: text("effect_md"),
		decidedBy: uuid("decided_by").references(() => user.id),
		decidedAt: at("decided_at"),
		...timestamps,
	},
	(t) => [
		index("canon_question_intake_id_status_idx").on(t.intakeId, t.status),
		index("canon_question_client_id_idx").on(t.clientId),
		// The session's intake and client, both: a question cannot name one
		// intake and hang off a session about another.
		foreignKey({
			name: "canon_question_session_intake_client_fk",
			columns: [t.canonSessionId, t.intakeId, t.clientId],
			foreignColumns: [
				canonSession.id,
				canonSession.intakeId,
				canonSession.clientId,
			],
		}),
		check(
			"canon_question_header_length",
			sql`char_length(btrim(${t.header})) between 1 and 12`,
		),
		// A CASE, not AND: SQL does not promise AND evaluates left to right,
		// and jsonb_array_length raises on a non-array. Defensive only: an AND
		// form passed the tests too (Postgres 17 short-circuited it).
		check(
			"canon_question_options_two_to_four",
			sql`case when jsonb_typeof(${t.options}) = 'array' then jsonb_array_length(${t.options}) between 2 and 4 else false end`,
		),
		// Every element, as one string: the pattern admits no comma, so joining
		// keeps elements apart. array_to_string skips nulls, so they are
		// refused on their own.
		check(
			"canon_question_source_chunk_ids_format",
			sql`array_position(${t.sourceChunkIds}, null) is null and array_to_string(${t.sourceChunkIds}, ',') ~ '^([0-9a-f]{64}:[1-9][0-9]*-[1-9][0-9]*(,[0-9a-f]{64}:[1-9][0-9]*-[1-9][0-9]*)*)?$'`,
		),
		check(
			"canon_question_decided_iff_not_open",
			sql`(${t.status} <> 'open') = (${t.decidedBy} is not null) and (${t.status} <> 'open') = (${t.decidedAt} is not null)`,
		),
	],
);

/** A client's project memory. Canon proposes; the operator keeps or removes. */
export const clientMemory = pgTable(
	"client_memory",
	{
		...id,
		clientId: uuid("client_id")
			.notNull()
			.references(() => client.id),
		contentMd: text("content_md").notNull(),
		status: clientMemoryStatus("status").notNull(),
		proposedByCanonSessionId: uuid("proposed_by_canon_session_id").references(
			() => canonSession.id,
		),
		decidedBy: uuid("decided_by").references(() => user.id),
		decidedAt: at("decided_at"),
		...timestamps,
	},
	(t) => [
		index("client_memory_client_id_idx").on(t.clientId),
		// A proposal comes from a session about this client, never another's.
		foreignKey({
			name: "client_memory_session_client_fk",
			columns: [t.proposedByCanonSessionId, t.clientId],
			foreignColumns: [canonSession.id, canonSession.clientId],
		}),
		check(
			"client_memory_decided_together",
			sql`(${t.decidedBy} is null) = (${t.decidedAt} is null)`,
		),
	],
);

export const canonSessionInsert = createInsertSchema(canonSession);
export const canonSessionSelect = createSelectSchema(canonSession);
export const canonMessageInsert = createInsertSchema(canonMessage);
export const canonMessageSelect = createSelectSchema(canonMessage);
export const canonQuestionInsert = createInsertSchema(canonQuestion);
export const canonQuestionSelect = createSelectSchema(canonQuestion);
export const clientMemoryInsert = createInsertSchema(clientMemory);
export const clientMemorySelect = createSelectSchema(clientMemory);
export const canonStepInsert = createInsertSchema(canonStep);
export const canonStepSelect = createSelectSchema(canonStep);
