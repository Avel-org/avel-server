import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { wave } from "./agent-template";
import { missionCut } from "./mission";
import { addRosterEntryBody } from "./roster";
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

const name = z.string().trim().min(1).max(200);
// The skill description's rule, nullable.
const description = z.string().trim().min(1).max(500).nullable();

/**
 * One agent as written. The keys are presetAgentSchema's, every one required,
 * so a preset read back can be sent again unchanged. The field rules are the
 * roster entry's, so applying a saved preset never meets a rule it skipped.
 */
export const presetAgentBody = presetAgentSchema
	.extend(
		addRosterEntryBody
			.pick({
				waves: true,
				territory: true,
				writablePaths: true,
				estimatedTokens: true,
			})
			.required().shape,
	)
	.strict();

/**
 * The agents must name live templates that may sit on a roster
 * (422 agent_template_not_found, template_not_rosterable), at most once per
 * territory (409 CONFLICT), as applying them would require. A new preset is
 * version 1.
 */
export const createPresetBody = z
	.object({
		name,
		description: description.optional(),
		cut: missionCut,
		agents: z.array(presetAgentBody),
	})
	.strict();

/** Any subset, at least one. agents replaces the whole list. Every update adds 1 to version. */
export const updatePresetBody = z
	.object({
		name: name.optional(),
		description: description.optional(),
		cut: missionCut.optional(),
		agents: z.array(presetAgentBody).optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

export type CreatePresetBody = z.infer<typeof createPresetBody>;
export type UpdatePresetBody = z.infer<typeof updatePresetBody>;

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
	create: {
		method: "POST",
		path: "/api/presets",
		body: createPresetBody,
		responses: { 201: successEnvelope(presetSchema) },
	},
	update: {
		method: "PATCH",
		path: "/api/presets/:id",
		pathParams: byId,
		body: updatePresetBody,
		responses: { 200: successEnvelope(presetSchema) },
		summary: "A missing or deleted preset is 404",
	},
});
