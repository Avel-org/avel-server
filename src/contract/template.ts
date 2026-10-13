import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { templateRef, templateVersion } from "./mission-plan";
import { successEnvelope } from "./shared/envelope";

const c = initContract();

/** The eight scopes in docs/TEMPLATES.md, in that order. */
export const TEMPLATE_SCOPES = [
	"full-stack",
	"frontend",
	"backend",
	"integration",
	"data",
	"automation",
	"migration",
	"audit",
] as const;

export const templateScope = z.enum(TEMPLATE_SCOPES);

export type TemplateScope = z.infer<typeof templateScope>;

export const startingState = z.enum(["greenfield", "brownfield"]);

export type StartingState = z.infer<typeof startingState>;

/** A template repository's .avel/template.json. Anything else in it is refused. */
export const templateManifest = z
	.object({
		name: z.string().trim().min(1).max(200),
		scope: templateScope,
		startingState,
	})
	.strict();

export type TemplateManifest = z.infer<typeof templateManifest>;

/**
 * A template, read from its repository (DATA-CONTRACTS-V2, Templates). Not
 * an entity: no table holds it. The manifest fields and latestSha are null
 * when the repository or its manifest could not be read.
 */
export const templateSchema = z.object({
	/** The repository name: a mission's templateRef and a playbook's missionType. */
	slug: templateRef,
	readable: z.boolean(),
	name: z.string().nullable(),
	scope: templateScope.nullable(),
	startingState: startingState.nullable(),
	/** The default branch's head commit. */
	latestSha: templateVersion.nullable(),
	/** The default preset of the live playbook keyed by this slug; null without one. */
	defaultPresetId: z.string().uuid().nullable(),
	/** Live missions whose templateRef is this slug. */
	missionCount: z.number().int().nonnegative(),
});

export type Template = z.infer<typeof templateSchema>;

const bySlug = z.object({ slug: z.string().min(1).max(200) });

export const templateContract = c.router({
	list: {
		method: "GET",
		path: "/api/templates",
		// Unpaginated: the allowlist is bounded configuration under source control.
		responses: { 200: successEnvelope(z.array(templateSchema)) },
		summary:
			"Every template in the allowlist, in allowlist order. An unreadable repository marks its own row and never fails the list",
	},
	get: {
		method: "GET",
		path: "/api/templates/:slug",
		pathParams: bySlug,
		responses: { 200: successEnvelope(templateSchema) },
		summary: "One template. A slug not in the allowlist is 404",
	},
});
