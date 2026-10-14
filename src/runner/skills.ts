import { and, eq } from "drizzle-orm";
import type { Role } from "../contract/agent-template";
import { skillsForAgent } from "../contract/shared/access";
import { missionSkills, skill } from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import { canonicalJson } from "../lib/canonical";
import { sha256Hex } from "../lib/tokens";

/** What skills_sha256 covers of one skill. */
export type HashedSkill = { slug: string; contentSha256: string };

/**
 * skills_sha256 (DATA-CONTRACTS-V2, CompletionReport; SKILLS.md): the hex
 * SHA-256 of canonicalJson([{ slug, contentSha256 }, ...]), sorted by slug
 * with a code-unit compare. No skills hashes `[]`, never null: a started
 * dispatch needs the hash by CHECK. Role skills are not in it; they are in
 * agent_version_sha256.
 */
export function skillsSha256(skills: readonly HashedSkill[]): string {
	const sorted = skills
		.map((s) => ({ slug: s.slug, contentSha256: s.contentSha256 }))
		.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	return sha256Hex(canonicalJson(sorted));
}

/** A skill attached to the mission, as dispatchSkillSet reads it. */
export type AttachedSkill = HashedSkill & {
	id: string;
	layer: "role" | "stack" | "domain";
	status: "draft" | "approved" | "retired";
	recommendedFor: readonly Role[];
};

/**
 * The stack and domain skills a dispatch is given: skillsForAgent's set
 * without the role layer. Approved, attached to the mission, and
 * recommended for one of the agent's roles. Pure. No role_skills rows go
 * in, so skillsForAgent keeps no role-layer skill, even one attached to
 * the mission.
 */
export function dispatchSkillSet(
	roles: readonly Role[],
	attached: readonly AttachedSkill[],
): AttachedSkill[] {
	return skillsForAgent({
		roles,
		skills: attached.map((s) => ({
			...s,
			recommendedFor: [...s.recommendedFor],
		})),
		roleSkills: [],
		missionSkillIds: attached.map((s) => s.id),
	});
}

/** dispatchSkillSet over the mission's live attached skills. */
export async function dispatchSkills(
	db: Executor,
	missionId: string,
	roles: readonly Role[],
): Promise<AttachedSkill[]> {
	const attached = await db
		.select({
			id: skill.id,
			slug: skill.slug,
			layer: skill.layer,
			status: skill.status,
			recommendedFor: skill.recommendedFor,
			contentSha256: skill.contentSha256,
		})
		.from(missionSkills)
		.innerJoin(skill, eq(skill.id, missionSkills.skillId))
		.where(and(eq(missionSkills.missionId, missionId), live(skill)));
	return dispatchSkillSet(roles, attached);
}
