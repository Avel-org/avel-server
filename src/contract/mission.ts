import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { activityActor } from "./activity";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";
import {
	exportStatus,
	type MISSION_STATUSES,
	missionStatus,
} from "./shared/status";

const c = initContract();

/** Must equal the mission_origin pgEnum; tests/api/mission.test.ts checks it. */
export const missionOrigin = z.enum(["internal", "client"]);
export const missionCut = z.enum(["horizontal", "vertical"]);
export const cutSource = z.enum(["derived", "overridden"]);
export const exportTargetKind = z.enum(["zip", "github_pr", "github_push"]);

/**
 * Why a mission needs the operator, derived from its last export's status.
 * A closed vocabulary; extending it is a contract change.
 */
export const needsYouReason = z.enum(["export_previewed", "pr_open"]);

export const missionSort = z.enum(["lastActivity", "sprint", "client"]);

const iso = z.string().datetime();

export const missionListItem = z.object({
	id: z.string().uuid(),
	origin: missionOrigin,
	type: z.string(),
	sprintN: z.number().int(),
	status: missionStatus,
	cut: missionCut,
	cutSource,
	/** Both null for an internal mission, which belongs to no engagement. */
	client: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
	engagement: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
	/** The newest export, dry-run previews included. Exports are never deleted. */
	lastExport: z
		.object({
			id: z.string().uuid(),
			status: exportStatus,
			targetKind: exportTargetKind,
			createdAt: iso,
			/** When the export entered its current status. Never before createdAt. */
			statusChangedAt: iso,
		})
		.nullable(),
	/** The newest ActivityLog row for the mission. Never updatedAt. Null when there is none. */
	lastActivityAt: iso.nullable(),
	needsYou: z.object({ reason: needsYouReason }).nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type MissionListItem = z.infer<typeof missionListItem>;

const count = z.number().int().nonnegative();

/** One key per MISSION_STATUSES value, zeros included. */
export const missionStatusCounts = z.object({
	draft: count,
	active: count,
	halted: count,
	shipped: count,
	archived: count,
}) satisfies z.ZodType<Record<(typeof MISSION_STATUSES)[number], number>>;

/** "true" | "false" from a query string. z.coerce.boolean would read "false" as true. */
const queryBoolean = z
	.enum(["true", "false"])
	.default("false")
	.transform((v) => v === "true");

export const missionListQuery = pageQuery.extend({
	/** Required: internal and client missions are never listed together (DATA-CONTRACTS-V2, Mission). */
	origin: missionOrigin,
	/**
	 * Several at once, in either form: repeated (?status=active&status=halted)
	 * or indexed, as ts-rest's client sends it (?status[0]=active&status[1]=halted).
	 */
	status: z
		.union([missionStatus, z.array(missionStatus)])
		.transform((v) => (Array.isArray(v) ? v : [v]))
		.optional(),
	/** Case-insensitive substring of the client name, engagement name or mission type. */
	q: z.string().trim().min(1).max(200).optional(),
	/** Keeps the missions of this client's engagements. A scope, like q: meta.counts follows it. */
	clientId: z.string().uuid().optional(),
	/** Keeps missions whose plan names this template (templateRef). A scope, like q. */
	templateRef: z.string().min(1).max(200).optional(),
	sort: missionSort.default("lastActivity"),
	/** Archived missions are hidden unless true, even when status=archived is asked for. */
	includeArchived: queryBoolean,
	/**
	 * "true" keeps only missions whose needsYou is non-null. "false", the
	 * default, applies no filter. meta.counts does not change with it.
	 */
	needsYou: queryBoolean,
	/**
	 * Keeps missions whose lastActivityAt is before this instant, or null:
	 * "no activity yet" counts as quiet. Pair with sort=lastActivity and
	 * direction=asc for quietest first.
	 */
	quietBefore: z.string().datetime().optional(),
	/** Keeps missions whose newest export's status is one of these. Repeat it, or index it. */
	lastExportStatus: z
		.union([exportStatus, z.array(exportStatus)])
		.transform((v) => (Array.isArray(v) ? v : [v]))
		.optional(),
	/**
	 * Overrides the sort's default direction (lastActivity desc, sprint desc,
	 * client asc). A null key is the lowest value: first when ascending, last
	 * when descending. Ties break on id in the same direction. A cursor is
	 * bound to its sort and direction.
	 */
	direction: z.enum(["asc", "desc"]).optional(),
});

export const missionListMeta = pageMeta.extend({
	/**
	 * The exact number of missions the list's filters keep (status, q,
	 * needsYou, quietBefore, lastExportStatus, includeArchived), ignoring the
	 * cursor: the same on every page. Always present on this route.
	 */
	total: z.number().int().nonnegative(),
	/**
	 * Counts over the same origin, q, clientId, templateRef and includeArchived as the list, but NOT
	 * the status, needsYou, quietBefore or lastExportStatus filters, so a
	 * status strip can show every count while one filter is selected.
	 */
	counts: z.object({
		byStatus: missionStatusCounts,
		needsYou: count,
	}),
});

export const missionListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(missionListItem),
	meta: missionListMeta,
});

export const missionActivity = z.object({
	action: z.string(),
	entityType: z.string(),
	at: iso,
	/**
	 * The activity feed's actor. display is the feed's label: the operator's
	 * GitHub login, "AVEL runner" for the system, "Name · territory" for an
	 * agent. Nullable on the wire, as before; the server never sends null.
	 */
	actor: activityActor.extend({ display: z.string().nullable() }),
});

export const missionDetail = missionListItem.extend({
	/** Deferred: an open record until the operator approves a brief shape. */
	brief: z.record(z.unknown()),
	spendCeilingUsd: z.number().nullable(),
	/** Every dispatch's spendUsd on this mission, summed. 0 before the first dispatch. */
	spentUsd: z.number().nonnegative(),
	cutRationale: z.string().nullable(),
	repoUrl: z.string(),
	/** Live roster entries, and how many of them are active. */
	roster: z.object({ agents: count, active: count }),
	/** Joined on mission.type = playbook.mission_type; null when no live playbook matches. */
	playbook: z.object({ missionType: z.string(), name: z.string() }).nullable(),
	lastExport: missionListItem.shape.lastExport
		.unwrap()
		.extend({
			/** Deferred: always null until gate decisions exist (module 9). */
			gates: z.null(),
		})
		.nullable(),
	/** The mission's ten newest ActivityLog rows, newest first. */
	recentActivity: z.array(missionActivity),
});

export type MissionDetail = z.infer<typeof missionDetail>;

export const missionContract = c.router({
	list: {
		method: "GET",
		path: "/api/missions",
		query: missionListQuery,
		responses: { 200: missionListEnvelope },
		summary: "Missions of one origin, with status counts",
	},
	get: {
		method: "GET",
		path: "/api/missions/:id",
		pathParams: z.object({ id: z.string().uuid() }),
		responses: { 200: successEnvelope(missionDetail) },
	},
});
