import { z } from "zod";
import type { Role } from "../agent-template";
import type { SkillListItem } from "../skill";

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

/** An override only narrows, so it never names a mode above read. */
export const accessOverrideMode = z.enum(["none", "read"]);

/** One tool row, lowered for one agent on one mission. */
export const accessOverride = z
	.object({
		skillId: z.string().uuid(),
		grant: z.string().trim().min(1).max(200),
		mode: accessOverrideMode,
	})
	.strict();

export type AccessOverride = z.infer<typeof accessOverride>;

export const accessRow = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("repository"),
		mode: z.enum(["write_held", "read"]),
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
		derivedMode: z.enum(["read", "write_held"]),
		/** The override's mode when one names this row, else derivedMode. */
		mode: z.enum(["none", "read", "write_held"]),
	}),
	z.object({
		kind: z.literal("delivery"),
		mode: z.literal("send_after_approval"),
	}),
]);

export type AccessRow = z.infer<typeof accessRow>;

export type GrantRow = Extract<AccessRow, { kind: "grant" }>;

export const agentAccess = z.object({
	/** False until module 7: a surface shows every row as recorded, not enforced. */
	enforced: z.literal(false),
	rows: z.array(accessRow),
});

export type AgentAccess = z.infer<typeof agentAccess>;

export type AccessSkill = Pick<
	SkillListItem,
	"id" | "slug" | "type" | "layer" | "status" | "recommendedFor" | "grants"
>;

export type AccessInput = {
	roles: readonly Role[];
	/** Resolved (resolveWritablePaths), never an entry's null. */
	writablePaths: readonly string[];
	/** Any skills; accessFor picks the ones this agent has. */
	skills: readonly AccessSkill[];
	/** The skills attached to the mission. */
	missionSkillIds: readonly string[];
	overrides?: readonly AccessOverride[] | null;
};

const RANK = { none: 0, read: 1, write_held: 2 } as const;

/** Split at the first ':'. The verb is null when there is no ':'. */
function parseGrant(grant: string): { system: string; verb: string | null } {
	const at = grant.indexOf(":");
	if (at === -1) return { system: grant, verb: null };
	return { system: grant.slice(0, at), verb: grant.slice(at + 1) };
}

/** Only the verb `read` reads. Anything else, unparsed included, overstates rather than hides. */
export function grantMode(grant: string): "read" | "write_held" {
	return parseGrant(grant).verb === "read" ? "read" : "write_held";
}

const rowKey = (skillId: string, grant: string) => `${skillId}\u0000${grant}`;

/**
 * The capability skills this agent has: approved, recommended for one of its
 * roles, and either role-layer or attached to the mission. Sorted by slug
 * with a code-unit compare, never the locale.
 */
function heldCapabilities(input: AccessInput): AccessSkill[] {
	const roles = new Set<Role>(input.roles);
	const attached = new Set(input.missionSkillIds);
	return input.skills
		.filter(
			(s) =>
				s.type === "capability" &&
				s.status === "approved" &&
				s.recommendedFor.some((r) => roles.has(r)) &&
				(s.layer === "role" || attached.has(s.id)),
		)
		.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export function accessFor(input: AccessInput): AgentAccess {
	const overrides = new Map<string, AccessOverride["mode"]>();
	for (const o of input.overrides ?? []) {
		const key = rowKey(o.skillId, o.grant);
		if (!overrides.has(key)) overrides.set(key, o.mode);
	}

	const grantRows: GrantRow[] = [];
	for (const skill of heldCapabilities(input)) {
		const seen = new Set<string>();
		for (const grant of skill.grants ?? []) {
			if (seen.has(grant)) continue;
			seen.add(grant);
			const derivedMode = grantMode(grant);
			const override = overrides.get(rowKey(skill.id, grant));
			grantRows.push({
				kind: "grant",
				skillId: skill.id,
				skillSlug: skill.slug,
				grant,
				system: parseGrant(grant).system,
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
	};
}

export type AccessIssue = { path: (string | number)[]; message: string };

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
