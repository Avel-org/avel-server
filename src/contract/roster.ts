import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { agentKind, role, wave } from "./agent-template";
import { successEnvelope } from "./shared/envelope";
import { skillListItem } from "./skill";

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

const byMission = z.object({ missionId: z.string().uuid() });

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
});
