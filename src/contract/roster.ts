import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { agentKind, role, wave } from "./agent-template";
import { accessOverride, agentAccess } from "./shared/access";
import { successEnvelope } from "./shared/envelope";
import { skillListItem } from "./skill";
import { removedSchema } from "./skill-source";

const c = initContract();

/** Must equal the grain pgEnum. 'merged' owns the boundaries in absorbedBoundaries. */
export const grain = z.enum(["merged", "default", "split"]);

export type Grain = z.infer<typeof grain>;

/** Must equal the mission_skill_source pgEnum: where a mission's skill came from. */
export const missionSkillSource = z.enum([
	"template",
	"pack",
	"client",
	"manual",
]);

export type MissionSkillSource = z.infer<typeof missionSkillSource>;

const iso = z.string().datetime();
const tokens = z.number().int().nonnegative().nullable();

/** One agent customized for one mission. Removed entries are never on the wire. */
export const rosterEntrySchema = z.object({
	id: z.string().uuid(),
	missionId: z.string().uuid(),
	/** The template it was made from, joined so the loadout needs no per-row lookup. */
	agentTemplate: z.object({
		id: z.string().uuid(),
		slug: z.string(),
		name: z.string(),
		kind: agentKind,
		roles: z.array(role),
	}),
	/** On the mission means this entry exists and is active. */
	active: z.boolean(),
	waves: z.array(wave),
	customizedMd: z.string().nullable(),
	/** Overrides the template's writablePaths for this mission. Null keeps the template's. */
	writablePaths: z.array(z.string()).nullable(),
	/** The part of the project this agent is scoped to, written Name · territory. */
	territory: z.string().nullable(),
	/** A planning default. Required before dispatch, which carries the binding value. */
	estimatedTokens: tokens,
	tokenSoftCeiling: tokens,
	tokenHardCeiling: tokens,
	grain,
	absorbedBoundaries: z.array(z.string()),
	/** Narrows accessFor's tool rows for this mission. Null when there are none. */
	accessOverrides: z.array(accessOverride).nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type RosterEntry = z.infer<typeof rosterEntrySchema>;

/** A skill on a mission: the skill without its text, and how it got there. */
export const missionSkillSchema = z.object({
	skill: skillListItem,
	source: missionSkillSource,
});

export type MissionSkill = z.infer<typeof missionSkillSchema>;

const tokenCount = z.number().int().positive();

/** What an operator sets on an entry. The template is chosen once, at add. */
const entryFields = {
	active: z.boolean(),
	waves: z.array(wave).min(1),
	customizedMd: z.string().min(1).max(20_000).nullable(),
	writablePaths: z.array(z.string().trim().min(1).max(500)).min(1).nullable(),
	territory: z.string().trim().min(1).max(200).nullable(),
	estimatedTokens: tokenCount.nullable(),
	tokenSoftCeiling: tokenCount.nullable(),
	tokenHardCeiling: tokenCount.nullable(),
	grain,
	absorbedBoundaries: z.array(z.string().trim().min(1).max(200)),
};

export type RosterEntryFields = {
	grain: Grain;
	absorbedBoundaries: string[];
	estimatedTokens: number | null;
	tokenSoftCeiling: number | null;
	tokenHardCeiling: number | null;
};

/**
 * What a whole entry must satisfy, whichever fields one request changed:
 * only a merged entry owns absorbed boundaries, and a merged one owns at
 * least one; estimate ≤ soft ceiling ≤ hard ceiling wherever both are set.
 * Pure, so the loadout can show the same problems the server refuses with
 * 400 VALIDATION_FAILED.
 */
export function rosterEntryProblems(
	entry: RosterEntryFields,
): Array<{ path: string[]; message: string }> {
	const problems: Array<{ path: string[]; message: string }> = [];
	if (entry.grain === "merged" && entry.absorbedBoundaries.length === 0) {
		problems.push({
			path: ["absorbedBoundaries"],
			message: "A merged entry owns at least one boundary",
		});
	}
	if (entry.grain !== "merged" && entry.absorbedBoundaries.length > 0) {
		problems.push({
			path: ["absorbedBoundaries"],
			message: "Only a merged entry owns absorbed boundaries",
		});
	}
	const { estimatedTokens: est, tokenSoftCeiling: soft } = entry;
	const hard = entry.tokenHardCeiling;
	if (est !== null && soft !== null && soft < est) {
		problems.push({
			path: ["tokenSoftCeiling"],
			message: "The soft ceiling is below the estimate",
		});
	}
	if (soft !== null && hard !== null && hard < soft) {
		problems.push({
			path: ["tokenHardCeiling"],
			message: "The hard ceiling is below the soft ceiling",
		});
	}
	if (est !== null && hard !== null && hard < est) {
		problems.push({
			path: ["tokenHardCeiling"],
			message: "The hard ceiling is below the estimate",
		});
	}
	return problems;
}

/**
 * Omitted fields default: active true, the template's waveDefaults, grain
 * 'default', no absorbed boundaries. With an estimate and no ceiling given,
 * the soft ceiling defaults to 1.5× and the hard to 3× (DATA-CONTRACTS-V2,
 * RosterEntry). An explicit null keeps a ceiling unset.
 */
export const addRosterEntryBody = z
	.object(entryFields)
	.partial()
	.extend({ agentTemplateId: z.string().uuid() })
	.strict();

/**
 * Any subset of fields, at least one. The template is not one of them.
 * accessOverrides replaces the whole list; null or an empty list clears it.
 * Each must name a tool row the agent has, once, and only narrow it
 * (422 access_override_invalid, with issues).
 */
export const updateRosterEntryBody = z
	.object({
		...entryFields,
		accessOverrides: z.array(accessOverride).max(200).nullable(),
	})
	.partial()
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

/**
 * Copies the preset's agents into new entries. A mission that already has
 * live entries is refused (422 roster_not_empty) unless replace is true,
 * which removes them first.
 */
export const applyPresetBody = z
	.object({
		presetId: z.string().uuid(),
		replace: z.boolean().default(false),
	})
	.strict();

/** Attaches an approved stack or domain skill, recorded with source 'manual'. */
export const attachSkillBody = z
	.object({ skillId: z.string().uuid() })
	.strict();

export type AddRosterEntryBody = z.infer<typeof addRosterEntryBody>;
export type UpdateRosterEntryBody = z.infer<typeof updateRosterEntryBody>;

const byMission = z.object({ missionId: z.string().uuid() });
const byEntry = byMission.extend({ entryId: z.string().uuid() });
const bySkill = byMission.extend({ skillId: z.string().uuid() });

/**
 * Every write below is refused unless the mission is a draft
 * (422 mission_not_editable).
 */
export const rosterContract = c.router({
	list: {
		method: "GET",
		path: "/api/missions/:missionId/roster",
		pathParams: byMission,
		// Unpaginated: a roster is a small, bounded child of one mission, and the
		// loadout needs all of it at once.
		responses: { 200: successEnvelope(z.array(rosterEntrySchema)) },
		summary: "The mission's live roster entries, oldest first",
	},
	skills: {
		method: "GET",
		path: "/api/missions/:missionId/skills",
		pathParams: byMission,
		responses: { 200: successEnvelope(z.array(missionSkillSchema)) },
		summary: "The live skills attached to the mission, oldest skill first",
	},
	access: {
		method: "GET",
		path: "/api/missions/:missionId/roster/:entryId/access",
		pathParams: byEntry,
		responses: { 200: successEnvelope(agentAccess) },
		summary:
			"accessFor on this entry, computed by the server: role_skills for its roles, the mission's skills, its overrides. Not enforced until module 7",
	},
	add: {
		method: "POST",
		path: "/api/missions/:missionId/roster",
		pathParams: byMission,
		body: addRosterEntryBody,
		responses: { 201: successEnvelope(rosterEntrySchema) },
		summary:
			"A live template once per territory: a second entry for the same template and territory is 409 CONFLICT.",
	},
	update: {
		method: "PATCH",
		path: "/api/missions/:missionId/roster/:entryId",
		pathParams: byEntry,
		body: updateRosterEntryBody,
		responses: { 200: successEnvelope(rosterEntrySchema) },
	},
	remove: {
		method: "DELETE",
		path: "/api/missions/:missionId/roster/:entryId",
		pathParams: byEntry,
		responses: { 200: successEnvelope(removedSchema) },
	},
	applyPreset: {
		method: "POST",
		path: "/api/missions/:missionId/roster/apply-preset",
		pathParams: byMission,
		body: applyPresetBody,
		responses: { 200: successEnvelope(z.array(rosterEntrySchema)) },
		summary:
			"Materializes the preset into entries and answers the whole roster",
	},
	attachSkill: {
		method: "POST",
		path: "/api/missions/:missionId/skills",
		pathParams: byMission,
		body: attachSkillBody,
		responses: { 201: successEnvelope(missionSkillSchema) },
		summary: "Attaching a skill already on the mission is 409 CONFLICT",
	},
	detachSkill: {
		method: "DELETE",
		path: "/api/missions/:missionId/skills/:skillId",
		pathParams: bySkill,
		responses: { 200: successEnvelope(removedSchema) },
		summary: "Answers the skill's id. A skill not on the mission is 404",
	},
});
