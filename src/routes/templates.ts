import { tsr } from "@ts-rest/serverless/fetch";
import { and, count, inArray } from "drizzle-orm";
import type { Context } from "hono";
import {
	ok,
	TEMPLATE_COVER_MAX_BYTES,
	type Template,
	templateContract,
	templateCoverUrl,
} from "../contract";
import { mission, playbook } from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import { imageType, type TemplateSource } from "../gateways/template-source";
import { ApiError } from "../middleware/errors";
import type { RequestContext, RouteDeps } from "./shared";

/**
 * Templates, read from their repositories (DATA-CONTRACTS-V2, Templates).
 * The repositories are read concurrently, but rows keep allowlist order.
 */
async function readTemplates(
	db: Executor,
	source: TemplateSource,
	slugs: readonly string[],
): Promise<Template[]> {
	if (slugs.length === 0) return [];
	const [reads, playbooks, counts] = await Promise.all([
		Promise.all(slugs.map((slug) => source.read(slug))),
		db
			.select({
				missionType: playbook.missionType,
				defaultPresetId: playbook.defaultPresetId,
			})
			.from(playbook)
			.where(and(inArray(playbook.missionType, [...slugs]), live(playbook))),
		db
			.select({ templateRef: mission.templateRef, n: count() })
			.from(mission)
			.where(and(inArray(mission.templateRef, [...slugs]), live(mission)))
			.groupBy(mission.templateRef),
	]);
	const presetFor = new Map(
		playbooks.map((p) => [p.missionType, p.defaultPresetId]),
	);
	const countFor = new Map(counts.map((c) => [c.templateRef, Number(c.n)]));
	return slugs.map((slug, i) => {
		const read = reads[i] ?? null;
		return {
			slug,
			readable: read !== null,
			name: read?.manifest.name ?? null,
			scope: read?.manifest.scope ?? null,
			startingState: read?.manifest.startingState ?? null,
			latestSha: read?.headSha ?? null,
			cover: read?.manifest.cover
				? {
						url: templateCoverUrl(slug, read.headSha),
						alt: read.manifest.cover.alt,
					}
				: null,
			defaultPresetId: presetFor.get(slug) ?? null,
			missionCount: countFor.get(slug) ?? 0,
		};
	});
}

export function templateRoutes(
	deps: RouteDeps & { templates: TemplateSource },
) {
	return tsr.platformContext<RequestContext>().router(templateContract, {
		list: async () => ({
			status: 200,
			body: ok(
				await readTemplates(deps.db(), deps.templates, deps.templates.slugs),
			),
		}),
		get: async ({ params }) => {
			if (!deps.templates.slugs.includes(params.slug)) {
				throw new ApiError(
					"NOT_FOUND",
					`No template ${params.slug} in the allowlist`,
				);
			}
			const [template] = await readTemplates(deps.db(), deps.templates, [
				params.slug,
			]);
			if (!template) throw new Error("unreachable: one slug, one row");
			return { status: 200, body: ok(template) };
		},
	});
}

/**
 * GET /api/templates/:slug/cover: the manifest's cover at the head commit,
 * as the image itself. A Hono route outside the contract, since its body is
 * not an envelope; a refusal still is one, through app.onError. The bytes
 * must be a PNG, JPEG or WebP by signature and at most
 * TEMPLATE_COVER_MAX_BYTES, or the answer is 404.
 */
export function templateCover(source: TemplateSource) {
	return async (ctx: Context) => {
		const slug = ctx.req.param("slug") ?? "";
		const missing = (why: string) =>
			new ApiError("NOT_FOUND", `Template ${slug} ${why}`);
		if (!source.slugs.includes(slug)) throw missing("is not in the allowlist");
		const read = await source.read(slug);
		const cover = read?.manifest.cover;
		if (!read || !cover) throw missing("has no cover");
		const bytes = await source.file(slug, read.headSha, cover.path);
		if (!bytes || bytes.byteLength > TEMPLATE_COVER_MAX_BYTES)
			throw missing("has no readable cover");
		const type = imageType(bytes);
		if (!type) throw missing("has a cover that is not a PNG, JPEG or WebP");
		const pinned = ctx.req.query("sha") === read.headSha;
		return new Response(bytes, {
			status: 200,
			headers: {
				"content-type": type,
				"content-length": String(bytes.byteLength),
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'",
				"cache-control": pinned
					? "private, max-age=31536000, immutable"
					: "private, no-cache",
			},
		});
	};
}
