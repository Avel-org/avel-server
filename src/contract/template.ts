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

/**
 * The largest cover served. GitHub's contents API inlines a file only up to
 * 1 MB, so a larger one cannot be read in one call.
 */
export const TEMPLATE_COVER_MAX_BYTES = 1_048_576;

/**
 * A cover image named by the manifest: a path inside the repository, no
 * leading slash and no "..". The extension is a hint only; the route serves
 * the file only when its bytes are a PNG, JPEG or WebP.
 */
export const templateCoverRef = z
	.object({
		path: z
			.string()
			.max(300)
			.regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.(png|jpe?g|webp)$/i),
		alt: z.string().trim().min(1).max(200),
	})
	.strict();

/** A template repository's .avel/template.json. Anything else in it is refused. */
export const templateManifest = z
	.object({
		name: z.string().trim().min(1).max(200),
		scope: templateScope,
		startingState,
		cover: templateCoverRef.optional(),
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
	/**
	 * The manifest's cover, served same-origin at the head commit. Null when
	 * the manifest names none. The url can still answer 404 when the file is
	 * missing, too large or not an image, so an <img> needs a fallback.
	 */
	cover: z.object({ url: z.string(), alt: z.string() }).nullable(),
	/** The default preset of the live playbook keyed by this slug; null without one. */
	defaultPresetId: z.string().uuid().nullable(),
	/** Live missions whose templateRef is this slug. */
	missionCount: z.number().int().nonnegative(),
});

export type Template = z.infer<typeof templateSchema>;

/**
 * Where a template's cover is served: GET, outside the JSON envelope (a
 * non-contract route, like /api/auth/*). With sha equal to the head commit
 * it is cached as immutable; any other sha, or none, serves the head's cover
 * uncached.
 */
export const templateCoverUrl = (slug: string, sha: string) =>
	`/api/templates/${slug}/cover?sha=${sha}`;

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
