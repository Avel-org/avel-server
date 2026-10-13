import { isNull, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { DELIVERABLES } from "../../contract/playbook";
import { MISSION_STATUSES } from "../../contract/shared/status";
import { client, engagement } from "./agency";
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
export const completionStatus = pgEnum("completion_status", [
	"complete",
	"blocked",
	"failed",
	"halted",
]);
export const haltReason = pgEnum("halt_reason", [
	"token_hard_ceiling",
	"spend_ceiling",
	"wall_clock",
]);
export const versionSource = pgEnum("version_source", [
	"recorded",
	"reconstructed",
]);
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
		/** A plain sentence or two for the catalog card. Null until written. */
		description: text("description"),
		identityMd: text("identity_md").notNull(),
		depthMd: text("depth_md").notNull(),
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
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("completion_report_roster_entry_id_idx").on(t.rosterEntryId),
		index("completion_report_mission_id_idx").on(t.missionId),
		check(
			"completion_report_halt_reason_iff_halted",
			sql`(${t.status} = 'halted') = (${t.haltReason} is not null)`,
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
		...timestamps,
	},
	(t) => [
		index("finding_mission_id_idx").on(t.missionId),
		index("finding_client_id_idx").on(t.clientId),
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
export const rosterPresetInsert = createInsertSchema(rosterPreset);
export const rosterPresetSelect = createSelectSchema(rosterPreset);
export const playbookInsert = createInsertSchema(playbook);
export const playbookSelect = createSelectSchema(playbook);
export const missionInsert = createInsertSchema(mission);
export const missionSelect = createSelectSchema(mission);
export const rosterEntryInsert = createInsertSchema(rosterEntry);
export const rosterEntrySelect = createSelectSchema(rosterEntry);
export const completionReportInsert = createInsertSchema(completionReport);
export const completionReportSelect = createSelectSchema(completionReport);
export const findingInsert = createInsertSchema(finding);
export const findingSelect = createSelectSchema(finding);
export const knowledgeEntryInsert = createInsertSchema(knowledgeEntry);
export const knowledgeEntrySelect = createSelectSchema(knowledgeEntry);
