import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";
import { oneOrMany, searchQuery } from "./shared/query";

const c = initContract();

/**
 * The closed role vocabulary from docs/ROLES.md, in catalog order. Must equal
 * the role pgEnum; tests/unit/catalog-contract.test.ts checks it.
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

/** The global phases A to E; E is Operate. Must equal the wave pgEnum. */
export const WAVES = ["A", "B", "C", "D", "E"] as const;

export const wave = z.enum(WAVES);

export type Wave = z.infer<typeof wave>;

/** Must equal the agent_kind pgEnum. */
export const agentKind = z.enum(["horizontal", "feature"]);

export type AgentKind = z.infer<typeof agentKind>;

const iso = z.string().datetime();

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
	identityMd: z.string(),
	depthMd: z.string(),
	/** Globs this agent may modify. A write outside them fails the ownership gate. */
	writablePaths: z.array(z.string()),
	version: z.number().int().positive(),
	createdAt: iso,
	updatedAt: iso,
});

export type AgentTemplate = z.infer<typeof agentTemplateSchema>;

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

const byId = z.object({ id: z.string().uuid() });
const bySlug = z.object({ slug: z.string().min(1).max(200) });

/** Module 4: read-only. Templates are written by the identity generator (module 5). */
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
});
