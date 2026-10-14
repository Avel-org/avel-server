import type {
	AgentResource,
	AgentRouteDeclaration,
	AgentVerb,
} from "../contract/agent";
import type { Role } from "../contract/agent-template";
import type { Team } from "../contract/role-labels";
import { roleFamily, roleRuntime } from "./roles";

/** The families an agent can belong to. platform is code only and has no agent. */
export type AgentFamily = Exclude<Team, "platform">;

export type FamilyAccess = Readonly<
	Record<AgentVerb, readonly AgentResource[]>
>;

/**
 * ROLES.md, What each family may do through the API: the one hand-written
 * piece of agent access. "Its own" is the route's to enforce, from the
 * token; this table says only which resource and verb a family may reach.
 *
 * Never listed here, whatever ROLES.md's table says: anything requiring an
 * operator in code (ROLES.md, Never on any agent's list). Those routes carry
 * no agent declaration, so no entry here can grant them.
 */
export const FAMILY_ACCESS = {
	foundation: { read: ["dispatch"], act: ["completion_report"], propose: [] },
	build: { read: ["dispatch"], act: ["completion_report"], propose: [] },
	verify: { read: ["dispatch"], act: ["completion_report"], propose: [] },
	// An open Finding on its own mission, besides its report.
	review: {
		read: ["dispatch"],
		act: ["completion_report", "finding"],
		propose: [],
	},
	// Empty until their modules build their routes: Operate reads the
	// delivered mission and proposes a follow-up; Firm reads across missions
	// and drafts intakes. Until then they are refused every agent route.
	operate: { read: [], act: [], propose: [] },
	firm: { read: [], act: [], propose: [] },
} as const satisfies Record<AgentFamily, FamilyAccess>;

/**
 * The family whose row governs a role, or null for a role no agent covers:
 * code roles, and foundations, which is the operator.
 */
export function agentFamilyOf(role: Role): AgentFamily | null {
	if (roleRuntime(role) !== "model") return null;
	const family = roleFamily(role);
	return Object.hasOwn(FAMILY_ACCESS, family) ? (family as AgentFamily) : null;
}

/**
 * Whether an agent covering `roles` may reach a route: the union over its
 * families (ROLES.md: an agent covering several roles gets all of them).
 */
export function agentMay(
	roles: readonly Role[],
	route: Pick<AgentRouteDeclaration, "resource" | "verb">,
): boolean {
	return roles.some((role) => {
		const family = agentFamilyOf(role);
		if (!family) return false;
		const allowed: readonly AgentResource[] = FAMILY_ACCESS[family][route.verb];
		return allowed.includes(route.resource);
	});
}
