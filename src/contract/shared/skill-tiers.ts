import type { Role } from "../agent-template";
import type { SkillListItem } from "../skill";

/**
 * Whether a skill may be attached to a mission: approved, and in the stack
 * or domain layer. Role-layer skills belong to roles (role_skills) and are
 * delivered in the identity file, never per mission. The server's attach
 * route refuses what this refuses.
 */
export function isMissionAttachable(
	skill: Pick<SkillListItem, "status" | "layer">,
): boolean {
	return skill.status === "approved" && skill.layer !== "role";
}

export type SkillTiers<T> = {
	/** Attachable, and recommended for at least one of the agent's roles. */
	recommended: T[];
	/** Attachable, but recommended for none of the agent's roles. */
	available: T[];
	/** Every skill given, attachable or not, so drafts and retired skills stay visible. */
	all: T[];
};

/**
 * The loadout's three tiers for one agent. Pure: no IO, no clock. Each tier
 * keeps the input order, so the same inputs give the same tiers.
 */
export function resolveSkillTiers<
	T extends Pick<SkillListItem, "status" | "layer" | "recommendedFor">,
>(roles: readonly Role[], skills: readonly T[]): SkillTiers<T> {
	const held = new Set<Role>(roles);
	const recommended: T[] = [];
	const available: T[] = [];
	for (const skill of skills) {
		if (!isMissionAttachable(skill)) continue;
		if (skill.recommendedFor.some((r) => held.has(r))) recommended.push(skill);
		else available.push(skill);
	}
	return { recommended, available, all: [...skills] };
}
