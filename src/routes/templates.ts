import { tsr } from "@ts-rest/serverless/fetch";
import { and, count, inArray } from "drizzle-orm";
import { ok, type Template, templateContract } from "../contract";
import { mission, playbook } from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import type { TemplateSource } from "../gateways/template-source";
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
