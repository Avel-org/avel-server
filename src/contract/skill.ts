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

/**
 * The roles a role-layer skill is attached to (role_skills), in ROLES
 * order. Identities are built from these, approved skills only. Empty
 * for a stack or domain skill, which goes on missions instead.
 */
const attached = { attachedRoles: z.array(role) };

/** One skill, with its text and the roles it is attached to. */
export const skillSchema = z.discriminatedUnion("type", [
	z.object({ ...skillCommon, ...skillContent, ...attached, ...knowledge }),
	z.object({ ...skillCommon, ...skillContent, ...attached, ...capability }),
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

/** Lowercase words joined by single hyphens: it becomes a file name in the export. */
const slug = z
	.string()
	.max(100)
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, digits and hyphens");
const name = z.string().trim().min(1).max(200);
/** Loaded into every relevant dispatch, so it is kept short. */
const description = z.string().trim().min(1).max(500);
const contentMd = z.string().min(1).max(100_000);
const avelEnhancementMd = z.string().min(1).max(100_000).nullable();
/** A skill recommended for no role is never delivered. */
const recommendedFor = z.array(role).min(1);
const grants = z.array(z.string().trim().min(1).max(200)).min(1);

const skillFields = {
	slug,
	name,
	description,
	contentMd,
	avelEnhancementMd: avelEnhancementMd.optional(),
	layer: skillLayer,
	recommendedFor,
	sourceId: z.string().uuid(),
};

/**
 * A new skill is always a draft at version 1. The server computes its
 * contentSha256. As in the table, a capability carries grants and ioShape
 * and a knowledge skill carries neither.
 */
export const createSkillBody = z.discriminatedUnion("type", [
	z.object({ ...skillFields, type: z.literal("knowledge") }).strict(),
	z
		.object({
			...skillFields,
			type: z.literal("capability"),
			grants,
			ioShape: skillIoShape,
		})
		.strict(),
]);

/**
 * Any subset of fields. Changing a hashed field of an approved skill returns
 * it to draft. A body that changes type must agree with itself: to
 * capability with grants and ioShape, to knowledge with neither. A body
 * that leaves type alone is checked against the stored type instead
 * (422 skill_capability_mismatch).
 */
export const updateSkillBody = z
	.object({
		slug: slug.optional(),
		name: name.optional(),
		description: description.optional(),
		contentMd: contentMd.optional(),
		avelEnhancementMd: avelEnhancementMd.optional(),
		layer: skillLayer.optional(),
		recommendedFor: recommendedFor.optional(),
		sourceId: z.string().uuid().optional(),
		type: skillType.optional(),
		grants: grants.nullable().optional(),
		ioShape: skillIoShape.nullable().optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	})
	.refine(
		(body) =>
			body.type !== "capability" ||
			(body.grants != null && body.ioShape != null),
		{ message: "A capability needs grants and ioShape", path: ["type"] },
	)
	.refine(
		(body) =>
			body.type !== "knowledge" ||
			(body.grants == null && body.ioShape == null),
		{
			message: "A knowledge skill carries no grants or ioShape",
			path: ["type"],
		},
	);

export type CreateSkillBody = z.infer<typeof createSkillBody>;
export type UpdateSkillBody = z.infer<typeof updateSkillBody>;

/**
 * Approval pins the hash the operator reviewed. If the skill changed since,
 * the hashes differ and approval is 409 CONFLICT.
 */
export const approveSkillBody = z
	.object({ contentSha256: z.string().regex(/^[0-9a-f]{64}$/) })
	.strict();

/** The whole set of roles a role-layer skill attaches to; [] detaches it from all. */
export const setSkillRolesBody = z.object({ roles: z.array(role) }).strict();

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
	create: {
		method: "POST",
		path: "/api/skills",
		body: createSkillBody,
		responses: { 201: successEnvelope(skillSchema) },
		summary:
			"A draft at version 1. A slug taken by a live skill is 409 CONFLICT.",
	},
	update: {
		method: "PATCH",
		path: "/api/skills/:id",
		pathParams: byId,
		body: updateSkillBody,
		responses: { 200: successEnvelope(skillSchema) },
		summary:
			"Bumps version and recomputes contentSha256. A retired skill is 409 CONFLICT.",
	},
	approve: {
		method: "POST",
		path: "/api/skills/:id/approve",
		pathParams: byId,
		body: approveSkillBody,
		responses: { 200: successEnvelope(skillSchema) },
		summary:
			"draft to approved, recording the reviewer. Any other status, or a stale hash, is 409 CONFLICT.",
	},
	retire: {
		method: "POST",
		path: "/api/skills/:id/retire",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(skillSchema) },
		summary: "draft or approved to retired. Retiring twice is 409 CONFLICT.",
	},
	setRoles: {
		method: "PUT",
		path: "/api/skills/:id/roles",
		pathParams: byId,
		body: setSkillRolesBody,
		responses: { 200: successEnvelope(skillSchema) },
		summary:
			"Sets the roles a role-layer skill is attached to. Another layer is 422 skill_not_role_layer; a retired skill is 409 CONFLICT. A draft may be attached; identities use approved skills only.",
	},
});
