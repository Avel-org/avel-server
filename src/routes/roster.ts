import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, eq } from "drizzle-orm";
import {
	type MissionSkill,
	ok,
	type RosterEntry,
	rosterContract,
} from "../contract";
import {
	agentTemplate,
	mission,
	missionSkills,
	rosterEntry,
	skill,
	skillSource,
} from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import { notFound, type RequestContext, type RouteDeps } from "./shared";
import { skillListColumns, toSkillListItem } from "./skills";

async function requireLiveMission(db: Executor, id: string): Promise<void> {
	const [row] = await db
		.select({ id: mission.id })
		.from(mission)
		.where(and(eq(mission.id, id), live(mission)));
	if (!row) throw notFound("mission", id);
}

type EntryRow = typeof rosterEntry.$inferSelect;
type TemplateRow = Pick<
	typeof agentTemplate.$inferSelect,
	"id" | "slug" | "name" | "kind" | "roles"
>;

function toWire(entry: EntryRow, template: TemplateRow): RosterEntry {
	return {
		id: entry.id,
		missionId: entry.missionId,
		agentTemplate: template,
		active: entry.active,
		waves: entry.waves,
		customizedMd: entry.customizedMd,
		writablePaths: entry.writablePaths,
		territory: entry.territory,
		estimatedTokens: entry.estimatedTokens,
		tokenSoftCeiling: entry.tokenSoftCeiling,
		tokenHardCeiling: entry.tokenHardCeiling,
		grain: entry.grain,
		absorbedBoundaries: entry.absorbedBoundaries,
		createdAt: entry.createdAt.toISOString(),
		updatedAt: entry.updatedAt.toISOString(),
	};
}

export function rosterRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(rosterContract, {
		list: async ({ params }) => {
			const db = deps.db();
			await requireLiveMission(db, params.missionId);
			// The template is joined whether or not it is live: an entry made from
			// a template deleted since still names the agent it was.
			const rows = await db
				.select({
					entry: rosterEntry,
					template: {
						id: agentTemplate.id,
						slug: agentTemplate.slug,
						name: agentTemplate.name,
						kind: agentTemplate.kind,
						roles: agentTemplate.roles,
					},
				})
				.from(rosterEntry)
				.innerJoin(
					agentTemplate,
					eq(agentTemplate.id, rosterEntry.agentTemplateId),
				)
				.where(
					and(eq(rosterEntry.missionId, params.missionId), live(rosterEntry)),
				)
				.orderBy(asc(rosterEntry.createdAt), asc(rosterEntry.id));
			return {
				status: 200,
				body: ok(rows.map((r) => toWire(r.entry, r.template))),
			};
		},

		skills: async ({ params }) => {
			const db = deps.db();
			await requireLiveMission(db, params.missionId);
			const rows = await db
				.select({ ...skillListColumns, attachedFrom: missionSkills.source })
				.from(missionSkills)
				.innerJoin(skill, eq(skill.id, missionSkills.skillId))
				.innerJoin(skillSource, eq(skillSource.id, skill.sourceId))
				.where(and(eq(missionSkills.missionId, params.missionId), live(skill)))
				.orderBy(asc(skill.createdAt), asc(skill.id));
			const items: MissionSkill[] = rows.map(({ attachedFrom, ...row }) => ({
				skill: toSkillListItem(row),
				source: attachedFrom,
			}));
			return { status: 200, body: ok(items) };
		},
	});
}
