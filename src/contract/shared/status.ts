import { z } from "zod";

/**
 * Status vocabularies that code branches on. These arrays are the single
 * source: the pgEnums in src/db/schema are built from them, so the database,
 * the contract and the frontend cannot disagree. Adding, removing or
 * reordering a value is a contract change and a migration.
 */
export const MISSION_STATUSES = [
	"draft",
	"active",
	"halted",
	"shipped",
	"archived",
] as const;

export const missionStatus = z.enum(MISSION_STATUSES);

export type MissionStatus = z.infer<typeof missionStatus>;

export const EXPORT_STATUSES = [
	"pending",
	"rendering",
	"verifying",
	"previewing",
	"previewed",
	"delivering",
	"pr-open",
	"done",
	"closed",
	"failed",
] as const;

export const exportStatus = z.enum(EXPORT_STATUSES);

export type ExportStatus = z.infer<typeof exportStatus>;

export const INTAKE_STATUSES = [
	"draft",
	"proposed",
	"approved",
	"rejected",
] as const;

export const intakeStatus = z.enum(INTAKE_STATUSES);

export type IntakeStatus = z.infer<typeof intakeStatus>;

/** Module 6. The pgEnum dispatch_status is built from this array. */
export const DISPATCH_STATUSES = [
	"queued",
	"running",
	"complete",
	"blocked",
	"failed",
	"halted",
] as const;

export const dispatchStatus = z.enum(DISPATCH_STATUSES);

export type DispatchStatus = z.infer<typeof dispatchStatus>;

/** How a dispatch ended: the statuses a CompletionReport can record. */
export const COMPLETION_STATUSES = [
	"complete",
	"blocked",
	"failed",
	"halted",
] as const;

export const completionStatus = z.enum(COMPLETION_STATUSES);

export type CompletionStatus = z.infer<typeof completionStatus>;

/**
 * Why a dispatch halted. The runner sets the first three at a ceiling;
 * operator is a manual stop (decided 2026-10-13).
 */
export const HALT_REASONS = [
	"token_hard_ceiling",
	"spend_ceiling",
	"wall_clock",
	"operator",
] as const;

export const haltReason = z.enum(HALT_REASONS);

export type HaltReason = z.infer<typeof haltReason>;

/** Whether a report's agent version was hashed at the run or rebuilt from git history. */
export const VERSION_SOURCES = ["recorded", "reconstructed"] as const;

export const versionSource = z.enum(VERSION_SOURCES);

export type VersionSource = z.infer<typeof versionSource>;
