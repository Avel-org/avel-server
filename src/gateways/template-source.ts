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
	/** One file's bytes at a commit, or null when it cannot be read whole. */
	file: (slug: string, sha: string, path: string) => Promise<Uint8Array | null>;
};

export const MANIFEST_PATH = ".avel/template.json";

/**
 * The image type a cover's bytes actually are, by their signature, or null.
 * The route trusts this, never the file's extension.
 */
export function imageType(
	bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | null {
	const starts = (sig: number[], at = 0) =>
		sig.every((b, i) => bytes[at + i] === b);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
		return "image/webp";
	return null;
}

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
		file: async (slug, sha, path) => {
			try {
				const file = await gh.rest.repos.getContent({
					owner: options.owner,
					repo: slug,
					path,
					ref: sha,
				});
				const data = file.data;
				// Over 1 MB, GitHub answers with encoding "none" and no content.
				if (
					Array.isArray(data) ||
					data.type !== "file" ||
					!("content" in data) ||
					data.encoding !== "base64"
				)
					return null;
				return new Uint8Array(Buffer.from(data.content, "base64"));
			} catch (e) {
				options.onError?.(slug, e);
				return null;
			}
		},
	};
}

/**
 * Serves fixed reads by slug; a slug with no read, or a null one, is
 * unreadable. Files are keyed "slug/path", at whatever sha the read names.
 */
export function fixtureTemplateSource(
	slugs: readonly string[],
	reads: Readonly<Record<string, TemplateRead | null>>,
	files: Readonly<Record<string, Uint8Array>> = {},
): TemplateSource {
	return {
		slugs,
		read: async (slug) => reads[slug] ?? null,
		file: async (slug, sha, path) =>
			reads[slug]?.headSha === sha ? (files[`${slug}/${path}`] ?? null) : null,
	};
}

/** Lists the slugs and reads none: production with no template credential configured. */
export function unreadableTemplates(slugs: readonly string[]): TemplateSource {
	return { slugs, read: async () => null, file: async () => null };
}

/** No templates at all, for tests that never call the route. */
export const noTemplates: TemplateSource = unreadableTemplates([]);
