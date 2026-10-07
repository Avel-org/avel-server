import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";
import { oneOrMany, searchQuery } from "./shared/query";

const c = initContract();

/** Must equal the skill_source_kind pgEnum. */
export const skillSourceKind = z.enum(["internal", "vendor", "community"]);

export type SkillSourceKind = z.infer<typeof skillSourceKind>;

const iso = z.string().datetime();

/** Where skills come from. An open catalog: rows, not an enum. Ships empty. */
export const skillSourceSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	kind: skillSourceKind,
	url: z.string().nullable(),
	license: z.string().nullable(),
	/** Live (not deleted) skills from this source, so a list needs no per-row count query. */
	skillCount: z.number().int().nonnegative(),
	createdAt: iso,
	updatedAt: iso,
});

export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillSourceListQuery = pageQuery.extend({
	/** Case-insensitive substring of the name. */
	q: searchQuery.optional(),
	kind: oneOrMany(skillSourceKind).optional(),
});

export type SkillSourceListQuery = z.infer<typeof skillSourceListQuery>;

const name = z.string().trim().min(1).max(200);
const url = z.string().trim().url().max(2_000).nullable();
const license = z.string().trim().min(1).max(200).nullable();

export const createSkillSourceBody = z
	.object({
		name,
		kind: skillSourceKind,
		url: url.optional(),
		license: license.optional(),
	})
	.strict();

export const updateSkillSourceBody = z
	.object({
		name: name.optional(),
		kind: skillSourceKind.optional(),
		url: url.optional(),
		license: license.optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

/** What a removal answers: the id that is no longer live. */
export const removedSchema = z.object({ id: z.string().uuid() });

const byId = z.object({ id: z.string().uuid() });

export const skillSourceContract = c.router({
	list: {
		method: "GET",
		path: "/api/skill-sources",
		query: skillSourceListQuery,
		responses: { 200: pageEnvelope(skillSourceSchema) },
		summary: "Skill sources, newest first",
	},
	get: {
		method: "GET",
		path: "/api/skill-sources/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(skillSourceSchema) },
	},
	create: {
		method: "POST",
		path: "/api/skill-sources",
		body: createSkillSourceBody,
		responses: { 201: successEnvelope(skillSourceSchema) },
	},
	update: {
		method: "PATCH",
		path: "/api/skill-sources/:id",
		pathParams: byId,
		body: updateSkillSourceBody,
		responses: { 200: successEnvelope(skillSourceSchema) },
	},
	remove: {
		method: "DELETE",
		path: "/api/skill-sources/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(removedSchema) },
		summary:
			"Soft-deletes the source. Refused while a live skill comes from it (422 skill_source_in_use).",
	},
});
