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
