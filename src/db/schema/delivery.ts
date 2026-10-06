import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { EXPORT_STATUSES } from "../../contract/shared/status";
import { engagement } from "./agency";
import { user } from "./auth";
import { id, softDelete, timestamps } from "./columns";
import { cut, exportTargetKind, gate } from "./enums";
import { connection } from "./platform";
import { mission, rosterPreset } from "./work";

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

export const intakeStatus = pgEnum("intake_status", [
	"draft",
	"proposed",
	"approved",
	"rejected",
]);
// Built from the contract array, so the database and avel-web cannot drift.
export const exportStatus = pgEnum("export_status", EXPORT_STATUSES);
export const proposalKind = pgEnum("proposal_kind", [
	"next_module",
	"calibration",
	"post_delivery",
	"intake_questions",
]);
export const proposalSource = pgEnum("proposal_source", ["code", "model"]);
export const proposalStatus = pgEnum("proposal_status", [
	"pending",
	"approved",
	"dismissed",
	"expired",
]);

/**
 * Canon's proposal. Never a Mission until an operator approves it. The derived_*
 * fields are computed by reading the repository, so a draft may not have them yet.
 */
export const intake = pgTable(
	"intake",
	{
		...id,
		engagementId: uuid("engagement_id")
			.notNull()
			.references(() => engagement.id),
		status: intakeStatus("status").notNull(),
		sourceMd: text("source_md").notNull(),
		proposedBrief: jsonb("proposed_brief"),
		openQuestions: text("open_questions").array().notNull(),
		derivedCut: cut("derived_cut"),
		derivedCutEvidence: text("derived_cut_evidence"),
		derivedConventions: jsonb("derived_conventions"),
		derivedBoundaries: jsonb("derived_boundaries"),
		suggestedPresetId: uuid("suggested_preset_id").references(
			() => rosterPreset.id,
		),
		approvedBy: uuid("approved_by").references(() => user.id),
		approvedAt: at("approved_at"),
		missionId: uuid("mission_id").references(() => mission.id),
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("intake_engagement_id_idx").on(t.engagementId),
		check(
			"intake_approval_complete",
			sql`${t.status} <> 'approved' or (${t.approvedBy} is not null and ${t.approvedAt} is not null and ${t.missionId} is not null)`,
		),
	],
);

/**
 * Immutable after freeze; only status and pr_status advance. A preview is a
 * real row with dry_run = true, terminal at 'previewed', and never promoted.
 * The snapshot fields stay null until the package is frozen.
 */
export const exportTable = pgTable(
	"export",
	{
		...id,
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		sprintN: integer("sprint_n").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		targetKind: exportTargetKind("target_kind").notNull(),
		connectionId: uuid("connection_id").references(() => connection.id),
		status: exportStatus("status").notNull(),
		// When the export entered its current status. Every write that changes
		// status sets this in the same statement, from the clock.
		statusChangedAt: at("status_changed_at").notNull(),
		prStatus: text("pr_status"),
		verification: jsonb("verification"),
		// The gate override, flattened so its author is a real foreign key.
		// All four are null, or all four are set (export_gate_override_complete).
		gateOverrideGate: gate("gate_override_gate"),
		gateOverrideJustification: text("gate_override_justification"),
		gateOverrideBy: uuid("gate_override_by").references(() => user.id),
		gateOverrideAt: at("gate_override_at"),
		replayOf: uuid("replay_of").references((): AnyPgColumn => exportTable.id),
		dryRun: boolean("dry_run").notNull().default(false),
		previewExportId: uuid("preview_export_id").references(
			(): AnyPgColumn => exportTable.id,
		),
		baseCommitSha: text("base_commit_sha"),
		baseRef: text("base_ref"),
		blastRadius: jsonb("blast_radius"),
		snapshotKey: text("snapshot_key"),
		snapshotSha256: text("snapshot_sha256"),
		snapshotBytes: bigint("snapshot_bytes", { mode: "number" }),
		versionManifest: jsonb("version_manifest"),
		contractSha256: text("contract_sha256"),
		// Null until render. The preview-versus-export determinism comparison uses these.
		packageSha256: text("package_sha256"),
		packageHashVersion: integer("package_hash_version"),
		...timestamps,
	},
	(t) => [
		uniqueIndex("export_idempotency_key_uq").on(t.idempotencyKey),
		index("export_mission_id_idx").on(t.missionId),
		check(
			"export_status_changed_after_created",
			sql`${t.statusChangedAt} >= ${t.createdAt}`,
		),
		check(
			"export_connection_unless_zip",
			sql`${t.targetKind} = 'zip' or ${t.connectionId} is not null`,
		),
		check(
			"export_gate_override_complete",
			sql`(${t.gateOverrideGate} is null and ${t.gateOverrideJustification} is null and ${t.gateOverrideBy} is null and ${t.gateOverrideAt} is null)
				or (${t.gateOverrideGate} is not null and ${t.gateOverrideJustification} is not null and btrim(${t.gateOverrideJustification}) <> '' and ${t.gateOverrideBy} is not null and ${t.gateOverrideAt} is not null)`,
		),
	],
);

/** Anything proactive reaches the operator as a proposal and does nothing on its own. */
export const proposal = pgTable(
	"proposal",
	{
		...id,
		kind: proposalKind("kind").notNull(),
		source: proposalSource("source").notNull(),
		engagementId: uuid("engagement_id").references(() => engagement.id),
		missionId: uuid("mission_id").references(() => mission.id),
		summary: text("summary").notNull(),
		payload: jsonb("payload").notNull(),
		premise: jsonb("premise").notNull(),
		status: proposalStatus("status").notNull(),
		reason: text("reason"),
		decidedBy: uuid("decided_by").references(() => user.id),
		decidedAt: at("decided_at"),
		...timestamps,
	},
	(t) => [
		index("proposal_engagement_id_idx").on(t.engagementId),
		index("proposal_mission_id_idx").on(t.missionId),
	],
);

export const intakeInsert = createInsertSchema(intake);
export const intakeSelect = createSelectSchema(intake);
export const exportInsert = createInsertSchema(exportTable);
export const exportSelect = createSelectSchema(exportTable);
export const proposalInsert = createInsertSchema(proposal);
export const proposalSelect = createSelectSchema(proposal);
