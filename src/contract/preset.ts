import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { wave } from "./agent-template";
import { missionCut } from "./mission";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";
import { oneOrMany, searchQuery } from "./shared/query";

const c = initContract();

const iso = z.string().datetime();

/** One agent in a saved squad. Applying the preset copies it into a RosterEntry. */
export const presetAgentSchema = z.object({
	agentTemplateId: z.string().uuid(),
	waves: z.array(wave),
	territory: z.string().nullable(),
	writablePaths: z.array(z.string()).nullable(),
	/** A default only. Every mission re-estimates. */
	estimatedTokens: z.number().int().nonnegative().nullable(),
});

export type PresetAgent = z.infer<typeof presetAgentSchema>;

/** A saved squad. It holds no mission state. Soft-deleted presets are never on the wire. */
export const presetSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
	cut: missionCut,
	agents: z.array(presetAgentSchema),
	version: z.number().int().positive(),
	createdAt: iso,
	updatedAt: iso,
});

export type Preset = z.infer<typeof presetSchema>;

export const presetListQuery = pageQuery.extend({
	/** Case-insensitive substring of the name. */
	q: searchQuery.optional(),
	cut: oneOrMany(missionCut).optional(),
});

export type PresetListQuery = z.infer<typeof presetListQuery>;

const byId = z.object({ id: z.string().uuid() });

export const presetContract = c.router({
	list: {
		method: "GET",
		path: "/api/presets",
		query: presetListQuery,
		responses: { 200: pageEnvelope(presetSchema) },
		summary: "Roster presets, newest first",
	},
	get: {
		method: "GET",
		path: "/api/presets/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(presetSchema) },
	},
});
