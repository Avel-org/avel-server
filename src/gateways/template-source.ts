import { Octokit } from "@octokit/rest";
import {
	type TemplateManifest,
	templateManifest,
	templateVersion,
} from "../contract";

/** What one template repository says about itself. */
export type TemplateRead = { manifest: TemplateManifest; headSha: string };

/**
 * Where the template route reads template repositories. An AppDeps gateway:
 * production reads GitHub, dev and tests read a fixture. A read that fails
 * for any reason answers null, so one repository never fails the list.
 */
export type TemplateSource = {
	/** The allowlist: the repositories to list, in display order. */
	slugs: readonly string[];
	read: (slug: string) => Promise<TemplateRead | null>;
};

export const MANIFEST_PATH = ".avel/template.json";

/** A manifest file's text as a manifest, or null when it does not parse. */
export function parseManifest(text: string): TemplateManifest | null {
	try {
		const parsed = templateManifest.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * GitHub: the default branch's head, and the manifest at that commit. The
 * token never leaves the gateway.
 */
export function githubTemplateSource(options: {
	slugs: readonly string[];
	owner: string;
	token: string;
	fetch?: typeof fetch;
	onError?: (slug: string, error: unknown) => void;
}): TemplateSource {
	const gh = new Octokit({
		auth: options.token,
		request: options.fetch ? { fetch: options.fetch } : undefined,
	});
	return {
		slugs: options.slugs,
		read: async (slug) => {
			try {
				const commit = await gh.rest.repos.getCommit({
					owner: options.owner,
					repo: slug,
					ref: "HEAD",
				});
				const headSha = commit.data.sha;
				const file = await gh.rest.repos.getContent({
					owner: options.owner,
					repo: slug,
					path: MANIFEST_PATH,
					ref: headSha,
				});
				const data = file.data;
				if (Array.isArray(data) || data.type !== "file" || !("content" in data))
					return null;
				const manifest = parseManifest(
					Buffer.from(data.content, "base64").toString("utf8"),
				);
				if (!manifest || !templateVersion.safeParse(headSha).success)
					return null;
				return { manifest, headSha };
			} catch (e) {
				options.onError?.(slug, e);
				return null;
			}
		},
	};
}

/** Serves fixed reads by slug; a slug with no read, or a null one, is unreadable. */
export function fixtureTemplateSource(
	slugs: readonly string[],
	reads: Readonly<Record<string, TemplateRead | null>>,
): TemplateSource {
	return { slugs, read: async (slug) => reads[slug] ?? null };
}

/** Lists the slugs and reads none: production with no template credential configured. */
export function unreadableTemplates(slugs: readonly string[]): TemplateSource {
	return { slugs, read: async () => null };
}

/** No templates at all, for tests that never call the route. */
export const noTemplates: TemplateSource = unreadableTemplates([]);
