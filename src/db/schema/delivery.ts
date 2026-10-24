import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	type PgTableExtraConfigValue,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { GATE_JOB_FAILURES, GATE_JOB_STATUSES } from "../../contract/gate-job";
import { EXPORT_STATUSES, INTAKE_STATUSES } from "../../contract/shared/status";
import { engagement } from "./agency";
import { user } from "./auth";
import { canonSession } from "./canon";
import { id, softDelete, timestamps } from "./columns";
import { cut, exportTargetKind, gate, type Wave } from "./enums";
import { connection } from "./platform";
import { mission, rosterPreset } from "./work";

/**
 * Canon's roster recommendation: a preset's agents, each with why. Shown
 * beside the presets, never stored as one. The cut follows derived_cut.
 */
export interface RecommendedRoster {
	agents: Array<{
		agentTemplateId: string;
		waves: Wave[];
		territory: string | null;
		writablePaths: string[] | null;
		estimatedTokens: number | null;
		reason: string;
	}>;
}

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

// Built from the contract arrays, so the database and avel-web cannot drift.
export const intakeStatus = pgEnum("intake_status", INTAKE_STATUSES);
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
		// The repository the derived_* fields were read from (normalized), and
		// the commit. Set together by read-repo; approve requires its repoUrl
		// to match.
		repoUrl: text("repo_url"),
		repoCommitSha: text("repo_commit_sha"),
		repoReadAt: at("repo_read_at"),
		// The Canon session that drafted it; null when the operator wrote it.
		// The composite key below holds it to a session about this intake.
		draftedByCanonSessionId: uuid("drafted_by_canon_session_id").references(
			(): AnyPgColumn => canonSession.id,
		),
		// Canon's roster recommendation, shown beside the presets, never stored
		// as one.
		recommendedRoster: jsonb("recommended_roster").$type<RecommendedRoster>(),
		...softDelete,
		...timestamps,
	},
	// Annotated: intake and canon_session reference each other.
	(t): PgTableExtraConfigValue[] => [
		index("intake_engagement_id_idx").on(t.engagementId),
		// The target of canon_session_intake_engagement_fk.
		uniqueIndex("intake_id_engagement_id_uq").on(t.id, t.engagementId),
		foreignKey({
			name: "intake_drafted_by_canon_session_fk",
			columns: [t.draftedByCanonSessionId, t.id],
			foreignColumns: [canonSession.id, canonSession.intakeId],
		}),
		check(
			"intake_approval_complete",
			sql`${t.status} <> 'approved' or (${t.approvedBy} is not null and ${t.approvedAt} is not null and ${t.missionId} is not null)`,
		),
		check(
			"intake_repo_read_complete",
			sql`(${t.repoUrl} is null and ${t.repoCommitSha} is null and ${t.repoReadAt} is null) or (${t.repoUrl} is not null and ${t.repoCommitSha} is not null and ${t.repoReadAt} is not null)`,
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
		// A github_pr export's pull request (2026-10-24): set once GitHub
		// opened it. The commit is the one AVEL made on the PR's branch.
		prNumber: integer("pr_number"),
		prUrl: text("pr_url"),
		prHeadRef: text("pr_head_ref"),
		prCommitSha: text("pr_commit_sha"),
		// Why a real export failed, for the operator: an error code and the
		// server's own message, never GitHub's response body.
		failureCode: text("failure_code"),
		failureMessage: text("failure_message"),
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
			"export_pr_commit_sha_hex",
			sql`${t.prCommitSha} is null or ${t.prCommitSha} ~ '^[0-9a-f]{40}$'`,
		),
		check(
			"export_pr_complete",
			sql`(${t.prNumber} is null) = (${t.prUrl} is null) and (${t.prNumber} is null) = (${t.prHeadRef} is null) and (${t.prNumber} is null) = (${t.prCommitSha} is null)`,
		),
		check(
			"export_pr_only_github_pr",
			sql`${t.prNumber} is null or ${t.targetKind} = 'github_pr'`,
		),
		// Filled at render, together (DATA-CONTRACTS-V2.md, Export). Past
		// rendering they are set, except on an export that failed, which may
		// have failed before it rendered. Every route that reads an export
		// reads all three.
		check(
			"export_rendered_complete",
			sql`(${t.versionManifest} is null) = (${t.packageSha256} is null) and (${t.versionManifest} is null) = (${t.packageHashVersion} is null)`,
		),
		check(
			"export_rendered_past_rendering",
			sql`${t.status} in ('pending', 'rendering', 'failed') or ${t.versionManifest} is not null`,
		),
		check(
			"export_failure_only_failed",
			sql`${t.failureCode} is null or (${t.status} = 'failed' and ${t.failureMessage} is not null)`,
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

export const gateJobStatus = pgEnum("gate_job_status", GATE_JOB_STATUSES);
export const gateJobFailure = pgEnum("gate_job_failure", GATE_JOB_FAILURES);

/**
 * A gate run in the background (decided 2026-10-23). The POST queues it with
 * the request's overrides; the gate tick runs it and, when done, names the
 * mission.gate_run row it wrote. At most one queued or running job per
 * mission. The eighth exception to the schema freeze, with J's approval of
 * background gate runs.
 */
export const gateJob = pgTable(
	"gate_job",
	{
		...id,
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		status: gateJobStatus("status").notNull(),
		// Who queued it: the actor of the run it makes.
		operatorId: uuid("operator_id")
			.notNull()
			.references(() => user.id),
		idempotencyKey: text("idempotency_key"),
		requestSha256: text("request_sha256").notNull(),
		overrides: jsonb("overrides").notNull(),
		// The integration commit the POST judged, which the overrides bind to.
		// Null only on jobs queued before drizzle/0051.
		commitSha: text("commit_sha"),
		// The mission.gate_run row it made. No foreign key: activity_log is
		// append-only, and a reference would turn its TRUNCATE refusal into a
		// foreign-key error instead of the append-only one.
		gateRunId: uuid("gate_run_id"),
		failureCode: gateJobFailure("failure_code"),
		failureReason: text("failure_reason"),
		failureMessage: text("failure_message"),
		checksTotal: integer("checks_total"),
		checksDone: integer("checks_done"),
		currentCheckId: text("current_check_id"),
		queuedAt: at("queued_at").notNull(),
		startedAt: at("started_at"),
		finishedAt: at("finished_at"),
		...timestamps,
	},
	(t) => [
		uniqueIndex("gate_job_one_active_per_mission_uq")
			.on(t.missionId)
			.where(sql`${t.status} in ('queued', 'running')`),
		uniqueIndex("gate_job_idempotency_key_uq")
			.on(t.missionId, t.idempotencyKey)
			.where(sql`${t.idempotencyKey} is not null`),
		index("gate_job_queue_idx").on(t.status, t.queuedAt, t.id),
		check(
			"gate_job_commit_sha_hex",
			sql`${t.commitSha} is null or ${t.commitSha} ~ '^[0-9a-f]{40}$'`,
		),
		check(
			"gate_job_request_sha256_hex",
			sql`${t.requestSha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"gate_job_run_iff_done",
			sql`(${t.status} = 'done') = (${t.gateRunId} is not null)`,
		),
		check(
			"gate_job_failure_iff_failed",
			sql`(${t.status} = 'failed') = (${t.failureCode} is not null)`,
		),
		check(
			"gate_job_reason_only_for_precondition",
			sql`${t.failureReason} is null or ${t.failureCode} = 'precondition_failed'`,
		),
		check(
			"gate_job_started_unless_queued",
			sql`(${t.status} = 'queued') = (${t.startedAt} is null)`,
		),
		check(
			"gate_job_finished_iff_ended",
			sql`(${t.status} in ('done', 'failed')) = (${t.finishedAt} is not null)`,
		),
		check(
			"gate_job_progress_counts",
			sql`(${t.checksTotal} is null) = (${t.checksDone} is null) and (${t.checksDone} is null or (${t.checksDone} >= 0 and ${t.checksDone} <= ${t.checksTotal}))`,
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
