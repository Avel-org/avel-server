import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { role } from "./agent-template";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";
import { oneOrMany, searchQuery } from "./shared/query";
import { skillSourceKind } from "./skill-source";

const c = initContract();

/** Must equal the skill_layer pgEnum. Decides where a skill is delivered. */
export const skillLayer = z.enum(["role", "stack", "domain"]);
/** Must equal the skill_type pgEnum. */
export const skillType = z.enum(["knowledge", "capability"]);
/** Must equal the skill_status pgEnum. Only approved skills can be attached. */
export const skillStatus = z.enum(["draft", "approved", "retired"]);

export type SkillLayer = z.infer<typeof skillLayer>;
export type SkillType = z.infer<typeof skillType>;
export type SkillStatus = z.infer<typeof skillStatus>;

const ioSize = z.enum(["large", "small"]);

/** A capability's declared inputs and outputs, which routing depends on. */
export const skillIoShape = z.object({ reads: ioSize, returns: ioSize });

export type SkillIoShape = z.infer<typeof skillIoShape>;

const iso = z.string().datetime();

const skillCommon = {
	id: z.string().uuid(),
	/** Unique among live skills. */
	slug: z.string(),
	name: z.string(),
	/** One or two sentences, always visible to the agent. */
	description: z.string(),
	layer: skillLayer,
	recommendedFor: z.array(role),
	/** The SkillSource row, joined so a list needs no per-row source query. */
	source: z.object({
		id: z.string().uuid(),
		name: z.string(),
		kind: skillSourceKind,
	}),
	/** Hash of description, content, enhancement, grants, ioShape, type and layer. */
	contentSha256: z.string(),
	status: skillStatus,
	/** The User who reviewed it. Null until reviewed. */
	reviewedBy: z.string().uuid().nullable(),
	reviewedAt: iso.nullable(),
	version: z.number().int().positive(),
	createdAt: iso,
	updatedAt: iso,
};

/** The full skill text, sent by get only. */
const skillContent = {
	/** The full skill, loaded only when the task needs it. */
	contentMd: z.string(),
	/** AVEL's additions to an imported skill, kept separate. */
	avelEnhancementMd: z.string().nullable(),
};

/**
 * The skill_capability_fields CHECK, as a type: a capability carries grants
 * and ioShape, a knowledge skill carries neither.
 */
const knowledge = {
	type: z.literal("knowledge"),
	grants: z.null(),
	ioShape: z.null(),
};
const capability = {
	type: z.literal("capability"),
	/** What the runner provides in the room, and nothing else. */
	grants: z.array(z.string()),
	ioShape: skillIoShape,
};

/** A skill in a list: everything but the text. Soft-deleted skills are never on the wire. */
export const skillListItem = z.discriminatedUnion("type", [
	z.object({ ...skillCommon, ...knowledge }),
	z.object({ ...skillCommon, ...capability }),
]);

export type SkillListItem = z.infer<typeof skillListItem>;

/** One skill, with its text. */
export const skillSchema = z.discriminatedUnion("type", [
	z.object({ ...skillCommon, ...skillContent, ...knowledge }),
	z.object({ ...skillCommon, ...skillContent, ...capability }),
]);

export type Skill = z.infer<typeof skillSchema>;

export const skillListQuery = pageQuery.extend({
	/** Case-insensitive substring of the slug, name or description. */
	q: searchQuery.optional(),
	layer: oneOrMany(skillLayer).optional(),
	type: skillType.optional(),
	status: oneOrMany(skillStatus).optional(),
	/** Keeps skills whose recommendedFor includes any of these roles. */
	role: oneOrMany(role).optional(),
	sourceId: z.string().uuid().optional(),
});

export type SkillListQuery = z.infer<typeof skillListQuery>;

const byId = z.object({ id: z.string().uuid() });
const bySlug = z.object({ slug: z.string().min(1).max(200) });

export const skillContract = c.router({
	list: {
		method: "GET",
		path: "/api/skills",
		query: skillListQuery,
		responses: { 200: pageEnvelope(skillListItem) },
		summary: "Skills, newest first, without their text",
	},
	get: {
		method: "GET",
		path: "/api/skills/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(skillSchema) },
	},
	getBySlug: {
		method: "GET",
		path: "/api/skills/by-slug/:slug",
		pathParams: bySlug,
		responses: { 200: successEnvelope(skillSchema) },
		summary: "The live skill with this slug. A deleted one is reached by id",
	},
});
