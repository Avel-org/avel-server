import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
	templateDispatchListEnvelope,
	templateDispatchListQuery,
} from "./dispatch";
import { agentAccess } from "./shared/access";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";
import { oneOrMany, searchQuery } from "./shared/query";
import { missionStatus } from "./shared/status";

const c = initContract();

/**
 * The closed role vocabulary from docs/ROLES.md, in catalog order. The role
 * pgEnum is built from it, so a change here is a migration;
 * tests/unit/catalog-contract.test.ts pins it.
 */
export const ROLES = [
	// Foundation
	"foundations",
	"schema",
	"contract",
	"design-system",
	"fixture",
	// Build
	"domain",
	"api-surface",
	"integration",
	"realtime",
	"auth",
	"state",
	"interface",
	// Verify
	"backend-tests",
	"frontend-tests",
	"property-tests",
	"accessibility",
	"performance",
	// Review
	"spec-check",
	"spec-judgment",
	"security-review",
	"compliance-review",
	"adversarial",
	"reconciliation",
	"concurrency",
	// Operate
	"deploy",
	"recovery",
	"observability",
	"incident-response",
	// Firm
	"intake",
	"strategy",
	"research",
	"client-ops",
	// Platform
	"knowledge",
	"render",
	"ship-decision",
] as const;

export const role = z.enum(ROLES);

export type Role = z.infer<typeof role>;

/**
 * The Firm family (docs/ROLES.md): agents that work between missions. Their
 * roles never appear in a mission roster (ROSTER-V2.md, Merging roles into
 * agents), so a template holding one cannot be put on a mission.
 */
export const FIRM_ROLES = [
	"intake",
	"strategy",
	"research",
	"client-ops",
] as const satisfies readonly Role[];

/** The global phases A to E; E is Operate. The wave pgEnum is built from it. */
export const WAVES = ["A", "B", "C", "D", "E"] as const;

export const wave = z.enum(WAVES);

export type Wave = z.infer<typeof wave>;

/** Must equal the agent_kind pgEnum. */
export const agentKind = z.enum(["horizontal", "feature"]);

export type AgentKind = z.infer<typeof agentKind>;

const iso = z.string().datetime();

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The inputs an identity is generated from, in the order staleInputs
 * names them. One moving makes the identity stale.
 */
export const IDENTITY_INPUT_FIELDS = [
	"generatorVersion",
	"slug",
	"name",
	"kind",
	"roles",
	"writablePaths",
	"definitionsSha256",
	"skills",
] as const;

export const identityInputField = z.enum(IDENTITY_INPUT_FIELDS);

export type IdentityInputField = z.infer<typeof identityInputField>;

/** An agent as data. Soft-deleted templates are never on the wire. */
export const agentTemplateSchema = z.object({
	id: z.string().uuid(),
	/** The path segment in the export, and the mount lookup key. Unique among live templates. */
	slug: z.string(),
	name: z.string(),
	kind: agentKind,
	roles: z.array(role),
	/** Null for a shared identity (Atlas), which serves every engagement. */
	engagementId: z.string().uuid().nullable(),
	waveDefaults: z.array(wave),
	/** Plain words for what the agent is, such as "Frontend engineer". Written, never derived. Null until written. */
	title: z.string().min(1).max(60).nullable(),
	/** A plain sentence or two for the catalog card, no markdown. Null until written. */
	description: z.string().min(1).max(280).nullable(),
	/** Globs this agent may modify. A write outside them fails the ownership gate. */
	writablePaths: z.array(z.string()),
	/**
	 * The identity version in force: the one generated from the template's
	 * current inputs, else the latest. Null when none was ever generated, and
	 * always null for the operator, whose human role gets no identity. The
	 * text itself is read through the version routes only.
	 */
	identityVersion: z.number().int().positive().nullable(),
	identitySha256: sha256.nullable(),
	/** True when regenerating would produce a different identity. */
	identityStale: z.boolean(),
	/** Which inputs moved since identityVersion was generated. Empty unless stale. */
	staleInputs: z.array(identityInputField),
	version: z.number().int().positive(),
	createdAt: iso,
	updatedAt: iso,
});

export type AgentTemplate = z.infer<typeof agentTemplateSchema>;

/** What an identity version was generated from (src/lib/identity.ts). */
export const identityInputsSchema = z.object({
	generatorVersion: z.string(),
	slug: z.string(),
	name: z.string(),
	kind: agentKind,
	roles: z.array(role),
	writablePaths: z.array(z.string()),
	/** Covers the role definitions used, which live in server code. */
	definitionsSha256: sha256,
	/** The approved role skills written in. */
	skills: z.array(z.object({ id: z.string().uuid(), contentSha256: sha256 })),
});

export type IdentityInputs = z.infer<typeof identityInputsSchema>;

/**
 * The token cap per generated file: identity.md and depth.md each, not
 * their sum (J, 2026-10-13). The generator refuses output over it
 * (identity_over_token_cap), and agent_identity_version's CHECKs match it
 * (drizzle/0024). Meters read it from here.
 */
export const IDENTITY_TOKEN_CAP = 1200;

/** One identity version without its text, for the version list. */
export const identityVersionSummary = z.object({
	/** The display id, `${slug}@v${number}`, such as atlas@v3. */
	ref: z.string(),
	number: z.number().int().positive(),
	/** CompletionReport.agent_version_sha256: identity.md, NUL, depth.md. */
	sha256,
	identityTokens: z.number().int().nonnegative(),
	depthTokens: z.number().int().nonnegative(),
	/** The operator who regenerated it. Null for one the seed wrote. */
	generatedBy: z.string().uuid().nullable(),
	createdAt: iso,
});

export type IdentityVersionSummary = z.infer<typeof identityVersionSummary>;

/** One identity version with its text. Versions are never changed or deleted. */
export const identityVersionSchema = identityVersionSummary.extend({
	agentTemplateId: z.string().uuid(),
	identityMd: z.string(),
	depthMd: z.string(),
	inputs: identityInputsSchema,
});

export type IdentityVersion = z.infer<typeof identityVersionSchema>;

/** Regenerate wrote a new version. */
export const identityRegenerated = z.object({
	created: z.literal(true),
	version: identityVersionSummary,
});

/**
 * Regenerate wrote nothing: the text equals an existing version. reused is
 * true when that version is not the latest (inputs went A, B, then A).
 */
export const identityUnchanged = z.object({
	created: z.literal(false),
	reused: z.boolean(),
	version: identityVersionSummary,
});

export const agentTemplateListQuery = pageQuery.extend({
	/** Case-insensitive substring of the slug or name. */
	q: searchQuery.optional(),
	kind: oneOrMany(agentKind).optional(),
	/** Keeps templates holding any of these roles. */
	role: oneOrMany(role).optional(),
	/** Keeps templates whose waveDefaults include any of these waves. */
	wave: oneOrMany(wave).optional(),
	/** Keeps templates scoped to this engagement. Shared templates have none. */
	engagementId: z.string().uuid().optional(),
});

export type AgentTemplateListQuery = z.infer<typeof agentTemplateListQuery>;

/** Where one agent sits: a live roster entry on a live mission. */
export const agentRosterEntrySchema = z.object({
	entryId: z.string().uuid(),
	missionId: z.string().uuid(),
	mission: z.object({
		type: z.string(),
		status: missionStatus,
		sprintN: z.number().int(),
		engagementId: z.string().uuid().nullable(),
	}),
	active: z.boolean(),
	territory: z.string().nullable(),
});

export type AgentRosterEntry = z.infer<typeof agentRosterEntrySchema>;

/** Each value once, first occurrence kept. */
function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

/** The catalog card is plain words: no markdown characters and no em dashes. */
const MARKDOWN = /[*_`#—]/;

/** Trimmed plain words, 1 to `max` characters. */
function plainWords(max: number) {
	return z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((s) => !MARKDOWN.test(s), {
			message: "Use plain words: no *, _, `, # or em dashes",
		});
}

/** Lowercase words joined by single hyphens: a path segment in the export. */
const templateSlug = z
	.string()
	.max(100)
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, digits and hyphens");

/**
 * A new template at version 1, with no identity: regenerate makes one.
 * roles and waveDefaults are deduped. writablePaths is never empty, as in
 * an update. A missing engagementId is a shared template. A Firm role is
 * allowed: a new template sits on no roster, and roster add refuses it there.
 */
export const createAgentTemplateBody = z
	.object({
		slug: templateSlug,
		name: z.string().trim().min(1).max(200),
		kind: agentKind,
		roles: z.array(role).min(1).transform(unique),
		waveDefaults: z.array(wave).transform(unique),
		writablePaths: z.array(z.string().min(1)).min(1),
		title: plainWords(60).nullable().optional(),
		description: plainWords(280).nullable().optional(),
		engagementId: z.string().uuid().nullable().optional(),
	})
	.strict();

export type CreateAgentTemplateBody = z.infer<typeof createAgentTemplateBody>;

/**
 * Any subset, at least one. slug, name, kind and engagementId are not
 * editable. null clears title or description. roles and waveDefaults are
 * deduped. writablePaths is never empty: an agent with no writable paths is
 * not an agent (ROSTER-V2.md, What is fixed). Every update adds 1 to
 * version; none regenerates the identity, so a roles or writablePaths
 * change reads stale until regenerated.
 */
export const updateAgentTemplateBody = z
	.object({
		title: plainWords(60).nullable().optional(),
		description: plainWords(280).nullable().optional(),
		roles: z.array(role).min(1).transform(unique).optional(),
		waveDefaults: z.array(wave).transform(unique).optional(),
		writablePaths: z.array(z.string().min(1)).min(1).optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

export type UpdateAgentTemplateBody = z.infer<typeof updateAgentTemplateBody>;

const byId = z.object({ id: z.string().uuid() });
const bySlug = z.object({ slug: z.string().min(1).max(200) });

/** Module 4 reads; module 5 adds the operator's edit and identity regeneration; create added 2026-10-21. */
export const agentTemplateContract = c.router({
	list: {
		method: "GET",
		path: "/api/agent-templates",
		query: agentTemplateListQuery,
		responses: { 200: pageEnvelope(agentTemplateSchema) },
		summary: "Agent templates, newest first",
	},
	get: {
		method: "GET",
		path: "/api/agent-templates/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(agentTemplateSchema) },
	},
	getBySlug: {
		method: "GET",
		path: "/api/agent-templates/by-slug/:slug",
		pathParams: bySlug,
		responses: { 200: successEnvelope(agentTemplateSchema) },
		summary: "The live template with this slug. A deleted one is reached by id",
	},
	create: {
		method: "POST",
		path: "/api/agent-templates",
		body: createAgentTemplateBody,
		responses: { 201: successEnvelope(agentTemplateSchema) },
		summary:
			"A new template at version 1, with no identity until regenerated. Refused (422 agent_roles_cross_sides, agent_role_not_assignable, engagement_not_found). A slug taken by a live template is 409 CONFLICT",
	},
	update: {
		method: "PATCH",
		path: "/api/agent-templates/:id",
		pathParams: byId,
		body: updateAgentTemplateBody,
		responses: { 200: successEnvelope(agentTemplateSchema) },
		summary:
			"Edits title, description, roles, waveDefaults or writablePaths. Refused (422 agent_roles_cross_sides, agent_role_not_assignable, and template_not_rosterable for a Firm role on a template rostered on a draft, active or halted mission). A missing or deleted template is 404",
	},
	dispatches: {
		method: "GET",
		path: "/api/agent-templates/:id/dispatches",
		pathParams: byId,
		query: templateDispatchListQuery,
		responses: { 200: templateDispatchListEnvelope },
		summary:
			"The template's dispatches across its identity versions, newest first, on missions the mission detail route shows. meta.totals follows the filters and ignores the cursor. A missing or deleted template is 404",
	},
	rosterEntries: {
		method: "GET",
		path: "/api/agent-templates/:id/roster-entries",
		pathParams: byId,
		// Unpaginated: bounded by missions, one entry per territory each.
		responses: { 200: successEnvelope(z.array(agentRosterEntrySchema)) },
		summary:
			"The template's live roster entries on live missions, newest mission first",
	},
	access: {
		method: "GET",
		path: "/api/agent-templates/:id/access",
		pathParams: byId,
		responses: { 200: successEnvelope(agentAccess) },
		summary:
			"accessFor outside any mission: role_skills for its roles, no mission skills, no overrides. Not enforced until module 7",
	},
	identityVersions: {
		method: "GET",
		path: "/api/agent-templates/:id/identity/versions",
		pathParams: byId,
		// Unpaginated: one row per regeneration that changed the text.
		responses: { 200: successEnvelope(z.array(identityVersionSummary)) },
		summary: "The template's identity versions, newest first, without text",
	},
	identityVersion: {
		method: "GET",
		path: "/api/agent-templates/:id/identity/versions/:number",
		pathParams: byId.extend({ number: z.coerce.number().int().positive() }),
		responses: { 200: successEnvelope(identityVersionSchema) },
		summary: "One identity version with its text",
	},
	regenerateIdentity: {
		method: "POST",
		path: "/api/agent-templates/:id/identity/regenerate",
		pathParams: byId,
		body: c.noBody(),
		responses: {
			201: successEnvelope(identityRegenerated),
			200: successEnvelope(identityUnchanged),
		},
		summary:
			"Generates the identity from the template's current inputs. 201 with a new version; 200 when the text equals an existing version, reused when that version is not the latest. Refused (422 identity_over_token_cap, identity_role_unsupported)",
	},
});

/** Resolves a recorded agent_version_sha256, or a display ref, to its text. */
export const identityVersionContract = c.router({
	get: {
		method: "GET",
		path: "/api/identity-versions/:ref",
		pathParams: z.object({ ref: z.string().min(1).max(220) }),
		responses: { 200: successEnvelope(identityVersionSchema) },
		summary:
			"A full 64-hex sha256, or slug@vN (atlas@v3). A sha names one version across all templates, deleted ones included",
	},
});
