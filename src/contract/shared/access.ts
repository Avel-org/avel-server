import { z } from "zod";
import type { Role } from "../agent-template";
import type { SkillListItem } from "../skill";
import type { ValidationIssue } from "./errors";

/**
 * Access (DATA-CONTRACTS-V2, Access). Derived, never stored: mounts decide
 * what an agent writes, a capability's grants decide which tools its room
 * holds, and delivery is the operator's. Pure: no database, no IO, no clock.
 * Nothing enforces it until the rooms of module 7, so every result says
 * enforced: false.
 */

/** No `write`: every file an agent writes is held until the gate passes. */
export const ACCESS_MODES = [
	"none",
	"read",
	"write_held",
	"send_after_approval",
] as const;

export const accessMode = z.enum(ACCESS_MODES);

export type AccessMode = z.infer<typeof accessMode>;

/** What a grant derives to. */
export const grantDerivedMode = accessMode.extract(["read", "write_held"]);

/** What a tool row can be: its derived mode, or lower. */
export const grantRowMode = accessMode.extract(["none", "read", "write_held"]);

/** An override only narrows, so it never names a mode above read. */
export const accessOverrideMode = accessMode.extract(["none", "read"]);

/**
 * One tool row, lowered for one agent on one mission. The grant is matched
 * verbatim; skill writes trim grants, so a stored grant has no edge spaces.
 */
export const accessOverride = z
	.object({
		skillId: z.string().uuid(),
		grant: z.string().min(1).max(200),
		mode: accessOverrideMode,
	})
	.strict();

export type AccessOverride = z.infer<typeof accessOverride>;

export const accessRow = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("repository"),
		mode: accessMode.extract(["write_held", "read"]),
		/** The resolved writable paths. */
		scope: z.array(z.string()),
	}),
	z.object({
		kind: z.literal("grant"),
		skillId: z.string().uuid(),
		skillSlug: z.string(),
		grant: z.string(),
		/** The grant up to its first ':', or the whole grant without one. */
		system: z.string(),
		derivedMode: grantDerivedMode,
		/** The override's mode when one names this row, else derivedMode. */
		mode: grantRowMode,
	}),
	z.object({
		kind: z.literal("delivery"),
		mode: accessMode.extract(["send_after_approval"]),
	}),
]);

export type AccessRow = z.infer<typeof accessRow>;

export type GrantRow = Extract<AccessRow, { kind: "grant" }>;

export const agentAccess = z.object({
	/** False until module 7: a surface shows every row as recorded, not enforced. */
	enforced: z.literal(false),
	rows: z.array(accessRow),
	/**
	 * Overrides that name no tool row the agent has now: the skill left, or
	 * its grant was renamed. Shown so a lost narrowing is never silent.
	 */
	staleOverrides: z.array(accessOverride),
});

export type AgentAccess = z.infer<typeof agentAccess>;

/** One role_skills row: a role-layer skill attached to a role. */
export type RoleSkill = { role: Role; skillId: string };

export type AgentSkillsInput<T> = {
	roles: readonly Role[];
	/** Candidates; skillsForAgent picks this agent's. */
	skills: readonly T[];
	/** role_skills rows. Rows for roles the agent does not hold are ignored. */
	roleSkills: readonly RoleSkill[];
	/** The skills attached to the mission (mission_skills). */
	missionSkillIds: readonly string[];
};

/**
 * The skills an agent receives (DATA-CONTRACTS-V2, Skill): approved, and
 * either a role-layer skill that role_skills attaches to one of its roles,
 * or a stack or domain skill attached to the mission and recommended for one
 * of its roles. Dispatch delivers the same set. Sorted by slug with a
 * code-unit compare, never the locale.
 */
export function skillsForAgent<
	T extends Pick<
		SkillListItem,
		"id" | "slug" | "layer" | "status" | "recommendedFor"
	>,
>(input: AgentSkillsInput<T>): T[] {
	const roles = new Set<Role>(input.roles);
	const viaRole = new Set(
		input.roleSkills.filter((r) => roles.has(r.role)).map((r) => r.skillId),
	);
	const attached = new Set(input.missionSkillIds);
	return input.skills
		.filter(
			(s) =>
				s.status === "approved" &&
				(s.layer === "role"
					? viaRole.has(s.id)
					: attached.has(s.id) && s.recommendedFor.some((r) => roles.has(r))),
		)
		.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export type AccessSkill = Pick<
	SkillListItem,
	"id" | "slug" | "type" | "layer" | "status" | "recommendedFor" | "grants"
>;

export type AccessInput = AgentSkillsInput<AccessSkill> & {
	/** Resolved (resolveWritablePaths), never an entry's null. */
	writablePaths: readonly string[];
	overrides?: readonly AccessOverride[] | null;
};

const RANK: Record<z.infer<typeof grantRowMode>, number> = {
	none: 0,
	read: 1,
	write_held: 2,
};

/** Split at the first ':'. Only the verb `read` reads; anything else, unparsed included, overstates rather than hides. */
export function parseGrant(grant: string): {
	system: string;
	derivedMode: z.infer<typeof grantDerivedMode>;
} {
	const at = grant.indexOf(":");
	return at === -1
		? { system: grant, derivedMode: "write_held" }
		: {
				system: grant.slice(0, at),
				derivedMode: grant.slice(at + 1) === "read" ? "read" : "write_held",
			};
}

/** A grant's derived mode. */
export function grantMode(grant: string): z.infer<typeof grantDerivedMode> {
	return parseGrant(grant).derivedMode;
}

const rowKey = (skillId: string, grant: string) => `${skillId}\u0000${grant}`;

export function accessFor(input: AccessInput): AgentAccess {
	const overrides = new Map<string, AccessOverride>();
	for (const o of input.overrides ?? []) {
		const key = rowKey(o.skillId, o.grant);
		if (!overrides.has(key)) overrides.set(key, o);
	}

	const grantRows: GrantRow[] = [];
	const used = new Set<string>();
	for (const skill of skillsForAgent(input)) {
		if (skill.type !== "capability") continue;
		for (const grant of skill.grants ?? []) {
			const key = rowKey(skill.id, grant);
			if (used.has(key)) continue;
			used.add(key);
			const { system, derivedMode } = parseGrant(grant);
			const override = overrides.get(key)?.mode;
			grantRows.push({
				kind: "grant",
				skillId: skill.id,
				skillSlug: skill.slug,
				grant,
				system,
				derivedMode,
				mode:
					override !== undefined && RANK[override] < RANK[derivedMode]
						? override
						: derivedMode,
			});
		}
	}

	return {
		enforced: false,
		rows: [
			{
				kind: "repository",
				mode: input.writablePaths.length > 0 ? "write_held" : "read",
				scope: [...input.writablePaths],
			},
			...grantRows,
			{ kind: "delivery", mode: "send_after_approval" },
		],
		staleOverrides: [...overrides]
			.filter(([key]) => !used.has(key))
			.map(([, o]) => o),
	};
}

/** The 422 details' issue: a ValidationIssue without a validator code. */
export type AccessIssue = Omit<ValidationIssue, "code">;

/**
 * What the roster update refuses (access_override_invalid), in override
 * order. An override must name a tool row the agent has, name it once, and
 * never raise its mode.
 */
export function checkAccessOverrides(
	rows: readonly AccessRow[],
	overrides: readonly AccessOverride[],
): AccessIssue[] {
	const derived = new Map<string, GrantRow["derivedMode"]>();
	for (const row of rows) {
		if (row.kind === "grant")
			derived.set(rowKey(row.skillId, row.grant), row.derivedMode);
	}
	const issues: AccessIssue[] = [];
	const named = new Set<string>();
	overrides.forEach((o, i) => {
		const key = rowKey(o.skillId, o.grant);
		const mode = derived.get(key);
		if (mode === undefined) {
			issues.push({
				path: [i],
				message: `The agent has no tool row for ${o.grant} on skill ${o.skillId}`,
			});
		} else if (named.has(key)) {
			issues.push({
				path: [i],
				message: `${o.grant} on skill ${o.skillId} is overridden twice`,
			});
		} else if (RANK[o.mode] > RANK[mode]) {
			issues.push({
				path: [i, "mode"],
				message: `An override only narrows: ${o.grant} is ${mode}, so it cannot become ${o.mode}`,
			});
		}
		named.add(key);
	});
	return issues;
}
