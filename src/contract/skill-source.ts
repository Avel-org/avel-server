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

const byId = z.object({ id: z.string().uuid() });

/**
 * Module 4 routes, published ahead of their handlers. Not mounted on the
 * contract router yet: a mounted route with no handler does not typecheck.
 */
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
});
