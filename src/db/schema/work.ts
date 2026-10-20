import { isNull, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { IdentityInputs } from "../../contract/agent-template";
import { type BriefRef, reportFiledBy } from "../../contract/dispatch";
import { DELIVERABLES } from "../../contract/playbook";
import {
	COMPLETION_STATUSES,
	DISPATCH_STATUSES,
	HALT_REASONS,
	MISSION_STATUSES,
	VERSION_SOURCES,
} from "../../contract/shared/status";
import { client, engagement } from "./agency";
import { user } from "./auth";
import { id, softDelete, timestamps } from "./columns";
import { cut, type Gate, role, type Wave, wave } from "./enums";

export const agentKind = pgEnum("agent_kind", ["horizontal", "feature"]);
export const missionOrigin = pgEnum("mission_origin", ["internal", "client"]);
// Built from the contract array, so the database and avel-web cannot drift.
export const missionStatus = pgEnum("mission_status", MISSION_STATUSES);
export const cutSource = pgEnum("cut_source", ["derived", "overridden"]);
// Built from the contract array, so the database and avel-web cannot drift.
export const deliverable = pgEnum("deliverable", DELIVERABLES);
export const grain = pgEnum("grain", ["merged", "default", "split"]);
// Built from the contract arrays, so the database and avel-web cannot drift.
export const completionStatus = pgEnum(
	"completion_status",
	COMPLETION_STATUSES,
);
export const haltReason = pgEnum("halt_reason", HALT_REASONS);
export const versionSource = pgEnum("version_source", VERSION_SOURCES);
export const dispatchStatus = pgEnum("dispatch_status", DISPATCH_STATUSES);
export const reportFiledByEnum = pgEnum(
	"report_filed_by",
	reportFiledBy.options,
);
export const findingSeverity = pgEnum("finding_severity", [
	"critical",
	"high",
	"medium",
	"low",
]);
export const findingStatus = pgEnum("finding_status", [
	"open",
	"confirmed",
	"dismissed",
]);
export const knowledgeType = pgEnum("knowledge_type", [
	"pattern",
	"decision",
	"registry",
	"component",
	"reference",
	"anti-pattern",
]);

/** An agent as data. engagement_id is nullable: one identity (Atlas) is shared across engagements. */
export const agentTemplate = pgTable(
	"agent_template",
	{
		...id,
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		kind: agentKind("kind").notNull(),
		roles: role("roles").array().notNull(),
		engagementId: uuid("engagement_id").references(() => engagement.id),
		waveDefaults: wave("wave_defaults").array().notNull(),
		/** The job title shown beside the name, such as "Backend tester". Null until written. */
		title: text("title"),
		/** A plain sentence or two for the catalog card. Null until written. */
		description: text("description"),
		writablePaths: text("writable_paths").array().notNull(),
		version: integer("version").notNull(),
		...softDelete,
		...timestamps,
	},
	(t) => [
		uniqueIndex("agent_template_slug_live_uq")
			.on(t.slug)
			.where(isNull(t.deletedAt)),
		index("agent_template_engagement_id_idx").on(t.engagementId),
		check(
			"agent_template_description_length",
			sql`char_length(${t.description}) between 1 and 280`,
		),
		check(
			"agent_template_title_length",
			sql`${t.title} is null or char_length(btrim(${t.title})) between 1 and 60`,
		),
	],
);

/**
 * One generated identity of an agent template. Append-only: a trigger
 * (drizzle/0023) refuses UPDATE, DELETE and TRUNCATE, so a version number
 * always names the same text. generated_by is null when the seed wrote it.
 */
export const agentIdentityVersion = pgTable(
	"agent_identity_version",
	{
		...id,
		agentTemplateId: uuid("agent_template_id")
			.notNull()
			.references(() => agentTemplate.id),
		number: integer("number").notNull(),
		identityMd: text("identity_md").notNull(),
		depthMd: text("depth_md").notNull(),
		sha256: text("sha256").notNull(),
		identityTokens: integer("identity_tokens").notNull(),
		depthTokens: integer("depth_tokens").notNull(),
		inputs: jsonb("inputs").$type<IdentityInputs>().notNull(),
		generatedBy: uuid("generated_by").references(() => user.id),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("agent_identity_version_template_number_uq").on(
			t.agentTemplateId,
			t.number,
		),
		uniqueIndex("agent_identity_version_template_sha256_uq").on(
			t.agentTemplateId,
			t.sha256,
		),
		index("agent_identity_version_sha256_idx").on(t.sha256),
		check("agent_identity_version_number_positive", sql`${t.number} > 0`),
		check(
			"agent_identity_version_sha256_hex",
			sql`${t.sha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"agent_identity_version_identity_tokens_range",
			sql`${t.identityTokens} between 0 and 1200`,
		),
		check(
			"agent_identity_version_depth_tokens_range",
			sql`${t.depthTokens} between 0 and 1200`,
		),
	],
);

export interface PresetAgent {
	agent_template_id: string;
	waves: Wave[];
	territory?: string;
	writable_paths?: string[];
	/** A default only. The RosterEntry it materializes into carries the real estimate. */
	estimated_tokens?: number;
}

/** A saved squad. Applying it materializes RosterEntries; it holds no mission state. */
export const rosterPreset = pgTable("roster_preset", {
	...id,
	name: text("name").notNull(),
	description: text("description"),
	cut: cut("cut").notNull(),
	agents: jsonb("agents").$type<PresetAgent[]>().notNull(),
	version: integer("version").notNull(),
	...softDelete,
	...timestamps,
});

export interface PlaybookGate {
	gate: Gate;
	policy: "mandatory" | "warn";
}

export const playbook = pgTable(
	"playbook",
	{
		...id,
		missionType: text("mission_type").notNull(),
		name: text("name").notNull(),
		wavesApplicable: wave("waves_applicable").array().notNull(),
		gates: jsonb("gates").$type<PlaybookGate[]>().notNull(),
		deliverable: deliverable("deliverable").notNull(),
		requiredFields: text("required_fields").array().notNull(),
		defaultPresetId: uuid("default_preset_id")
			.notNull()
			.references(() => rosterPreset.id),
		version: integer("version").notNull(),
		...softDelete,
		...timestamps,
	},
	(t) => [
		uniqueIndex("playbook_mission_type_live_uq")
			.on(t.missionType)
			.where(isNull(t.deletedAt)),
	],
);

/** Joins Playbook on mission.type = playbook.mission_type. No foreign key between them. */
export const mission = pgTable(
	"mission",
	{
		...id,
		// Required for a client mission, absent for an internal one
		// (mission_engagement_matches_origin).
		engagementId: uuid("engagement_id").references(() => engagement.id),
		origin: missionOrigin("origin").notNull(),
		type: text("type").notNull(),
		brief: jsonb("brief").notNull(),
		sprintN: integer("sprint_n").notNull(),
		status: missionStatus("status").notNull(),
		cut: cut("cut").notNull(),
		cutSource: cutSource("cut_source").notNull(),
		cutRationale: text("cut_rationale"),
		repoUrl: text("repo_url").notNull(),
		spendCeilingUsd: numeric("spend_ceiling_usd", { precision: 12, scale: 2 }),
		// The template slug it was built from and that template repository's
		// commit sha; both or neither (mission_template_complete).
		templateRef: text("template_ref"),
		templateVersion: text("template_version"),
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("mission_engagement_id_idx").on(t.engagementId),
		check(
			"mission_engagement_matches_origin",
			sql`(${t.origin} = 'client' and ${t.engagementId} is not null) or (${t.origin} = 'internal' and ${t.engagementId} is null)`,
		),
		check(
			"mission_override_has_rationale",
			sql`${t.cutSource} <> 'overridden' or (${t.cutRationale} is not null and btrim(${t.cutRationale}) <> '')`,
		),
		check(
			"mission_template_complete",
			sql`(${t.templateRef} is null and ${t.templateVersion} is null) or (${t.templateRef} is not null and ${t.templateVersion} ~ '^[0-9a-f]{40}$')`,
		),
	],
);

/** An AccessOverride as stored: snake_case, like PresetAgent. */
export interface StoredAccessOverride {
	skill_id: string;
	grant: string;
	mode: "none" | "read";
}

/** One agent customized for one mission. */
export const rosterEntry = pgTable(
	"roster_entry",
	{
		...id,
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		agentTemplateId: uuid("agent_template_id")
			.notNull()
			.references(() => agentTemplate.id),
		active: boolean("active").notNull(),
		waves: wave("waves").array().notNull(),
		customizedMd: text("customized_md"),
		writablePaths: text("writable_paths").array(),
		territory: text("territory"),
		// Nullable until dispatch: a preset's estimate is a default only.
		estimatedTokens: integer("estimated_tokens"),
		tokenSoftCeiling: integer("token_soft_ceiling"),
		tokenHardCeiling: integer("token_hard_ceiling"),
		grain: grain("grain").notNull(),
		absorbedBoundaries: text("absorbed_boundaries").array().notNull(),
		// Narrows accessFor's tool rows for this mission; null means none.
		accessOverrides: jsonb("access_overrides").$type<StoredAccessOverride[]>(),
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("roster_entry_mission_id_idx").on(t.missionId),
		index("roster_entry_agent_template_id_idx").on(t.agentTemplateId),
		// The target of dispatch's composite foreign key: a dispatch names an
		// entry together with that entry's own mission.
		uniqueIndex("roster_entry_id_mission_id_uq").on(t.id, t.missionId),
	],
);

const SHA256_HEX = sql.raw(`'^[0-9a-f]{64}$'`);

/**
 * One run of one agent on one piece of work (module 6). Evidence, so no soft
 * delete. Mission-scoped only for now (D8); firm sessions arrive later. The
 * composite foreign key to roster_entry(id, mission_id) means a dispatch can
 * never name another mission's entry. token_sha256 and idempotency_key are
 * never sent on the wire.
 */
export const dispatch = pgTable(
	"dispatch",
	{
		...id,
		rosterEntryId: uuid("roster_entry_id")
			.notNull()
			.references(() => rosterEntry.id),
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		briefRef: jsonb("brief_ref").$type<BriefRef>(),
		status: dispatchStatus("status").notNull(),
		haltReason: haltReason("halt_reason"),
		estimatedTokens: integer("estimated_tokens").notNull(),
		tokenSoftCeiling: integer("token_soft_ceiling").notNull(),
		tokenHardCeiling: integer("token_hard_ceiling").notNull(),
		// The runner's running count; always the sum of the four splits.
		tokensUsed: integer("tokens_used").notNull(),
		tokensIn: integer("tokens_in").notNull(),
		tokensOut: integer("tokens_out").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		softCeilingCrossed: boolean("soft_ceiling_crossed").notNull(),
		spendUsd: numeric("spend_usd", { precision: 14, scale: 6 }).notNull(),
		wallClockMinutes: integer("wall_clock_minutes").notNull(),
		// Frozen at start. The version id resolves agentVersionRef: the sha
		// alone can match several versions, one per template.
		agentIdentityVersionId: uuid("agent_identity_version_id").references(
			() => agentIdentityVersion.id,
		),
		agentVersionSha256: text("agent_version_sha256"),
		skillsSha256: text("skills_sha256"),
		// Step 9: the rendered brief and its hash, frozen at start together.
		briefMd: text("brief_md"),
		briefSha256: text("brief_sha256"),
		harnessVersion: text("harness_version"),
		model: text("model"),
		priceVersion: text("price_version"),
		tokenSha256: text("token_sha256"),
		idempotencyKey: text("idempotency_key").notNull(),
		// SHA-256 of the create request's body: the same key with the same
		// hash replays, with another hash it is refused.
		requestSha256: text("request_sha256").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
		...timestamps,
	},
	(t) => [
		index("dispatch_mission_id_idx").on(t.missionId),
		index("dispatch_roster_entry_id_idx").on(t.rosterEntryId),
		index("dispatch_mission_id_status_idx").on(t.missionId, t.status),
		uniqueIndex("dispatch_token_sha256_uq").on(t.tokenSha256),
		uniqueIndex("dispatch_mission_id_idempotency_key_uq").on(
			t.missionId,
			t.idempotencyKey,
		),
		// The target of finding's composite foreign key.
		uniqueIndex("dispatch_id_mission_id_uq").on(t.id, t.missionId),
		// The target of completion_report's composite foreign key.
		uniqueIndex("dispatch_id_mission_id_roster_entry_id_uq").on(
			t.id,
			t.missionId,
			t.rosterEntryId,
		),
		foreignKey({
			name: "dispatch_roster_entry_mission_fk",
			columns: [t.rosterEntryId, t.missionId],
			foreignColumns: [rosterEntry.id, rosterEntry.missionId],
		}),
		check(
			"dispatch_halt_reason_iff_halted",
			sql`(${t.status} = 'halted') = (${t.haltReason} is not null)`,
		),
		check("dispatch_estimate_positive", sql`${t.estimatedTokens} > 0`),
		check(
			"dispatch_soft_ceiling_at_least_estimate",
			sql`${t.tokenSoftCeiling} >= ${t.estimatedTokens}`,
		),
		check(
			"dispatch_hard_ceiling_at_least_soft",
			sql`${t.tokenHardCeiling} >= ${t.tokenSoftCeiling}`,
		),
		check(
			"dispatch_token_split_nonnegative",
			sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`,
		),
		check(
			"dispatch_tokens_used_is_split_sum",
			sql`${t.tokensUsed} = ${t.tokensIn} + ${t.tokensOut} + ${t.cacheReadTokens} + ${t.cacheWriteTokens}`,
		),
		check("dispatch_spend_nonnegative", sql`${t.spendUsd} >= 0`),
		check("dispatch_wall_clock_positive", sql`${t.wallClockMinutes} > 0`),
		check(
			"dispatch_started_iff_not_queued",
			sql`(${t.status} <> 'queued') = (${t.startedAt} is not null)`,
		),
		check(
			"dispatch_closed_iff_ended",
			sql`(${t.status} in ('complete', 'blocked', 'failed', 'halted')) = (${t.closedAt} is not null)`,
		),
		check(
			"dispatch_closed_after_started",
			sql`${t.closedAt} is null or ${t.closedAt} >= ${t.startedAt}`,
		),
		check(
			"dispatch_frozen_once_started",
			sql`${t.status} = 'queued' or (${t.agentIdentityVersionId} is not null and ${t.agentVersionSha256} is not null and ${t.skillsSha256} is not null and ${t.model} is not null and ${t.priceVersion} is not null)`,
		),
		check(
			"dispatch_agent_version_sha256_hex",
			sql`${t.agentVersionSha256} is null or ${t.agentVersionSha256} ~ ${SHA256_HEX}`,
		),
		check(
			"dispatch_skills_sha256_hex",
			sql`${t.skillsSha256} is null or ${t.skillsSha256} ~ ${SHA256_HEX}`,
		),
		check(
			"dispatch_brief_sha256_hex",
			sql`${t.briefSha256} is null or ${t.briefSha256} ~ ${SHA256_HEX}`,
		),
		check(
			"dispatch_brief_md_iff_sha256",
			sql`(${t.briefMd} is null) = (${t.briefSha256} is null)`,
		),
		check(
			"dispatch_token_sha256_hex",
			sql`${t.tokenSha256} is null or ${t.tokenSha256} ~ ${SHA256_HEX}`,
		),
		check(
			"dispatch_request_sha256_hex",
			sql`${t.requestSha256} ~ ${SHA256_HEX}`,
		),
	],
);

export interface ArtifactRef {
	path: string;
	sha256: string;
}

export interface Blocker {
	description: string;
	workaround: string;
	provisioning_gap: boolean;
}

/** An EdgeMismatch as stored: snake_case, like Blocker. */
export interface StoredEdgeMismatch {
	path: string;
	read_sha256: string;
	written_sha256: string;
	producer_dispatch_id: string;
}

/** What an agent produced and the evidence it consumed. Required to close a dispatch. */
export const completionReport = pgTable(
	"completion_report",
	{
		...id,
		rosterEntryId: uuid("roster_entry_id")
			.notNull()
			.references(() => rosterEntry.id),
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		// One report closes one dispatch: unique, and tied to that dispatch's
		// own mission and entry by the composite foreign key.
		dispatchId: uuid("dispatch_id").notNull(),
		status: completionStatus("status").notNull(),
		haltReason: haltReason("halt_reason"),
		softCeilingCrossed: boolean("soft_ceiling_crossed").notNull(),
		actualTokens: integer("actual_tokens").notNull(),
		agentVersionSha256: text("agent_version_sha256").notNull(),
		skillsSha256: text("skills_sha256").notNull(),
		versionSource: versionSource("version_source").notNull(),
		model: text("model").notNull(),
		artifactsRead: jsonb("artifacts_read").$type<ArtifactRef[]>().notNull(),
		artifactsWritten: jsonb("artifacts_written")
			.$type<ArtifactRef[]>()
			.notNull(),
		filesTouched: integer("files_touched").notNull(),
		fileTypesTouched: text("file_types_touched").array().notNull(),
		rereads: integer("rereads").notNull(),
		blockers: jsonb("blockers").$type<Blocker[]>().notNull(),
		edgeMismatches: jsonb("edge_mismatches")
			.$type<StoredEdgeMismatch[]>()
			.notNull(),
		filedBy: reportFiledByEnum("filed_by").notNull(),
		// The dispatch's commit, as the agent reported it. Only an agent's own
		// report carries one; a report the system files never does. The
		// sixth freeze exception (J, 2026-10-19).
		resultCommitSha: text("result_commit_sha"),
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("completion_report_roster_entry_id_idx").on(t.rosterEntryId),
		index("completion_report_mission_id_idx").on(t.missionId),
		uniqueIndex("completion_report_dispatch_id_uq").on(t.dispatchId),
		foreignKey({
			name: "completion_report_dispatch_fk",
			columns: [t.dispatchId, t.missionId, t.rosterEntryId],
			foreignColumns: [dispatch.id, dispatch.missionId, dispatch.rosterEntryId],
		}),
		check(
			"completion_report_halt_reason_iff_halted",
			sql`(${t.status} = 'halted') = (${t.haltReason} is not null)`,
		),
		check(
			"completion_report_result_commit_sha_hex",
			sql`${t.resultCommitSha} is null or ${t.resultCommitSha} ~ '^[0-9a-f]{40}$'`,
		),
		check(
			"completion_report_system_has_no_commit",
			sql`${t.filedBy} <> 'system' or ${t.resultCommitSha} is null`,
		),
	],
);

/** Evidence. Never deleted: removal is status = 'dismissed', with a reason. */
export const finding = pgTable(
	"finding",
	{
		...id,
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		clientId: uuid("client_id").references(() => client.id),
		rule: text("rule").notNull(),
		subject: text("subject").notNull(),
		severity: findingSeverity("severity").notNull(),
		class: text("class").notNull(),
		status: findingStatus("status").notNull(),
		dismissedReason: text("dismissed_reason"),
		caughtBy: text("caught_by").notNull(),
		// Set from the token when a judge writes the finding; null when code
		// or the operator records it. The key makes a judge's retry idempotent.
		reportedByDispatchId: uuid("reported_by_dispatch_id").references(
			() => dispatch.id,
		),
		idempotencyKey: text("idempotency_key"),
		// SHA-256 of the request body, stored beside the key (Idempotency).
		requestSha256: text("request_sha256"),
		...timestamps,
	},
	(t) => [
		index("finding_mission_id_idx").on(t.missionId),
		index("finding_client_id_idx").on(t.clientId),
		// A judge's finding lands on its own dispatch's mission, never another.
		foreignKey({
			name: "finding_dispatch_mission_fk",
			columns: [t.reportedByDispatchId, t.missionId],
			foreignColumns: [dispatch.id, dispatch.missionId],
		}),
		uniqueIndex("finding_dispatch_idempotency_key_uq")
			.on(t.reportedByDispatchId, t.idempotencyKey)
			.where(
				sql`${t.reportedByDispatchId} is not null and ${t.idempotencyKey} is not null`,
			),
		check(
			"finding_idempotency_key_iff_dispatch",
			sql`(${t.idempotencyKey} is not null) = (${t.reportedByDispatchId} is not null)`,
		),
		check(
			"finding_request_sha256_iff_key",
			sql`(${t.requestSha256} is not null) = (${t.idempotencyKey} is not null)`,
		),
		check(
			"finding_request_sha256_hex",
			sql`${t.requestSha256} is null or ${t.requestSha256} ~ ${SHA256_HEX}`,
		),
		check(
			"finding_dismissed_has_reason",
			sql`${t.status} <> 'dismissed' or (${t.dismissedReason} is not null and btrim(${t.dismissedReason}) <> '')`,
		),
	],
);

/** client_id is the one-way door: null means general, never client-specific. No write path in V1. */
export const knowledgeEntry = pgTable(
	"knowledge_entry",
	{
		...id,
		type: knowledgeType("type").notNull(),
		agentId: uuid("agent_id").references(() => agentTemplate.id),
		clientId: uuid("client_id").references(() => client.id),
		supersedes: uuid("supersedes").references(
			(): AnyPgColumn => knowledgeEntry.id,
		),
		contentMd: text("content_md").notNull(),
		version: integer("version").notNull(),
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("knowledge_entry_agent_id_idx").on(t.agentId),
		index("knowledge_entry_client_id_idx").on(t.clientId),
	],
);

export const agentTemplateInsert = createInsertSchema(agentTemplate);
export const agentTemplateSelect = createSelectSchema(agentTemplate);
export const agentIdentityVersionInsert =
	createInsertSchema(agentIdentityVersion);
export const agentIdentityVersionSelect =
	createSelectSchema(agentIdentityVersion);
export const rosterPresetInsert = createInsertSchema(rosterPreset);
export const rosterPresetSelect = createSelectSchema(rosterPreset);
export const playbookInsert = createInsertSchema(playbook);
export const playbookSelect = createSelectSchema(playbook);
export const missionInsert = createInsertSchema(mission);
export const missionSelect = createSelectSchema(mission);
export const rosterEntryInsert = createInsertSchema(rosterEntry);
export const rosterEntrySelect = createSelectSchema(rosterEntry);
export const dispatchInsert = createInsertSchema(dispatch);
export const dispatchSelect = createSelectSchema(dispatch);
export const completionReportInsert = createInsertSchema(completionReport);
export const completionReportSelect = createSelectSchema(completionReport);
export const findingInsert = createInsertSchema(finding);
export const findingSelect = createSelectSchema(finding);
export const knowledgeEntryInsert = createInsertSchema(knowledgeEntry);
export const knowledgeEntrySelect = createSelectSchema(knowledgeEntry);
