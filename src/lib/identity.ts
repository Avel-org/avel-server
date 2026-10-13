import { createHash } from "node:crypto";
import {
	type AgentKind,
	IDENTITY_INPUT_FIELDS,
	IDENTITY_TOKEN_CAP,
	type IdentityInputField,
	type IdentityInputs,
	ROLES,
	type Role,
} from "../contract/agent-template";
import { ROLE_LABELS } from "../contract/role-labels";
import type { SkillStatus } from "../contract/skill";
import {
	identitySupported,
	ROLE_DEFINITIONS,
	type RoleDefinition,
	roleSide,
} from "./roles";

/**
 * The identity generator (module 5). Pure: no database, no clock, no IO. An
 * agent's identity.md and depth.md are generated from the roles it covers
 * plus its mount (ROSTER-V2.md, What is fixed), never hand-written, so they
 * cannot drift from the role catalog. Per-mission paths and edges belong to
 * the dispatch brief (module 6), not here (J, 2026-10-13, decision a).
 */

/**
 * Bumped whenever the generated text or the token estimate changes, so every
 * identity built by an older generator reads stale (decision b).
 */
export const GENERATOR_VERSION = "identity-v1";

/**
 * Each file's cap, enforced on output (DATA-CONTRACTS-V2, AgentTemplate):
 * 1200 tokens, raised from 800 for both files (J, 2026-10-13). Defined in
 * the contract so avel-web reads the same number; re-exported here so
 * existing imports keep working. The database CHECKs match it (drizzle/0024).
 */
export { IDENTITY_TOKEN_CAP };

/**
 * A conservative token estimate: one token per 3.5 UTF-8 bytes, rounded up.
 * Real tokenizers average nearer 4 bytes per token on English and code, so
 * this overcounts, and a file under the cap here is under it in practice.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 3.5);
}

/**
 * CompletionReport.agent_version_sha256 (decision g): SHA-256 over
 * identity_md, one NUL byte, then depth_md, all UTF-8. The NUL keeps
 * ("ab", "c") and ("a", "bc") apart.
 */
export function identitySha256(identityMd: string, depthMd: string): string {
	return createHash("sha256")
		.update(identityMd, "utf8")
		.update(Buffer.from([0]))
		.update(depthMd, "utf8")
		.digest("hex");
}

/**
 * A role-layer skill that role_skills attaches to one of the agent's roles.
 * Role skills are part of who the agent is and are hashed with the identity
 * (docs/SKILLS.md); only approved ones are written in (J, 2026-10-13).
 */
export type IdentitySkill = {
	id: string;
	slug: string;
	name: string;
	description: string;
	contentMd: string;
	avelEnhancementMd: string | null;
	contentSha256: string;
	status: SkillStatus;
};

/** The template fields, and its role skills, an identity is built from. */
export type IdentitySource = {
	slug: string;
	name: string;
	kind: AgentKind;
	roles: readonly Role[];
	writablePaths: readonly string[];
	roleSkills: readonly IdentitySkill[];
};

// IdentityInputs is the contract's: what a version was generated from,
// stored with it. A template whose current inputs differ is stale, and
// staleInputs names what moved. definitionsSha256 covers the role
// definitions used, so an edit to src/lib/roles.ts makes the agents
// holding that role stale too.

export type GeneratedIdentity = {
	identityMd: string;
	depthMd: string;
	sha256: string;
	identityTokens: number;
	depthTokens: number;
	inputs: IdentityInputs;
	/** Attached role skills left out because they are not approved. */
	skippedSkills: { id: string; slug: string; status: SkillStatus }[];
};

export type IdentityRefusal =
	| { refused: "identity_role_unsupported"; roles: Role[] }
	| {
			refused: "identity_over_token_cap";
			file: "identity" | "depth";
			tokens: number;
			cap: number;
	  };

/** Roles in catalog order, each once, so input order never changes the text. */
function catalogOrder(roles: readonly Role[]): Role[] {
	const held = new Set(roles);
	return ROLES.filter((r) => held.has(r));
}

/** Code-point order, never locale order (docs/DEV-TIPS.md, section 2). */
function sortedPaths(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Each skill once, by slug in code-point order, then id. */
function skillOrder(skills: readonly IdentitySkill[]): IdentitySkill[] {
	const byId = new Map(skills.map((s) => [s.id, s]));
	return [...byId.values()].sort((a, b) =>
		a.slug !== b.slug ? (a.slug < b.slug ? -1 : 1) : a.id < b.id ? -1 : 1,
	);
}

function approvedSkills(source: IdentitySource): IdentitySkill[] {
	return skillOrder(source.roleSkills).filter((s) => s.status === "approved");
}

function definitionsSha256(roles: readonly Role[]): string {
	const encoded = JSON.stringify(
		roles.map((r) => {
			const d: RoleDefinition = ROLE_DEFINITIONS[r];
			return [r, d.produces, d.consumes, d.checkedBy, d.measuredBy, d.guidance];
		}),
	);
	return createHash("sha256").update(encoded, "utf8").digest("hex");
}

export function identityInputs(source: IdentitySource): IdentityInputs {
	const roles = catalogOrder(source.roles);
	return {
		generatorVersion: GENERATOR_VERSION,
		slug: source.slug,
		name: source.name,
		kind: source.kind,
		roles,
		writablePaths: sortedPaths(source.writablePaths),
		definitionsSha256: definitionsSha256(roles),
		skills: approvedSkills(source).map((s) => ({
			id: s.id,
			contentSha256: s.contentSha256,
		})),
	};
}

export type { IdentityInputField, IdentityInputs };

/** The input fields that differ, in a fixed order. Empty means not stale. */
export function staleInputs(
	stored: IdentityInputs,
	current: IdentityInputs,
): IdentityInputField[] {
	return IDENTITY_INPUT_FIELDS.filter(
		(f) => JSON.stringify(stored[f]) !== JSON.stringify(current[f]),
	);
}

const SIDE_LINE = {
	author: "You write source. Nothing you write grades your own work.",
	tester: "You write tests. You never modify the code under test.",
	judge: "You write findings. You never write source or tests.",
	fixture:
		"You write the expected result from the specification alone, without seeing the code.",
} as const;

const KIND_LINE = {
	horizontal: "You own one layer across every feature.",
	feature: "You own one feature through every layer it needs.",
} as const;

function roleHeading(r: Role): string {
	return `${ROLE_LABELS[r]} (\`${r}\`)`;
}

function renderIdentity(
	inputs: IdentityInputs,
	skills: readonly IdentitySkill[],
): string {
	const { roles } = inputs;
	const side = roleSide(roles[0] as Role);
	const guidance = [
		...new Set(roles.flatMap((r) => ROLE_DEFINITIONS[r].guidance)),
	];
	const lines = [
		`# ${inputs.slug}`,
		"",
		`You are ${inputs.name}. ${KIND_LINE[inputs.kind]}`,
		...(side ? [SIDE_LINE[side]] : []),
		"",
		"## Roles",
		"",
		...roles.flatMap((r) => {
			const d = ROLE_DEFINITIONS[r];
			return [
				`### ${roleHeading(r)}`,
				"",
				`Produces: ${d.produces}`,
				`Reads: ${d.consumes.join(", ")}`,
				"",
			];
		}),
		"## Mount",
		"",
		...(inputs.writablePaths.length > 0
			? ["Writable:", ...inputs.writablePaths.map((p) => `  ${p}`)]
			: ["Writable: nothing"]),
		"",
		"A write outside this set fails the ownership check and the mission does not ship. The filesystem enforces it, not your judgment.",
		"",
		"## Rules",
		"",
		...guidance.map((g) => `- ${g}`),
		"",
		...(skills.length > 0
			? [
					"## Skills",
					"",
					"Your depth file holds each skill in full.",
					"",
					...skills.map((s) => `- ${s.name} (\`${s.slug}\`): ${s.description}`),
					"",
				]
			: []),
		"## Blockers",
		"",
		"If the dispatch forbids something you need, file a blocker with a documented workaround. Do not absorb it silently and do not route around the boundary.",
		"",
	];
	return lines.join("\n");
}

function renderDepth(
	inputs: IdentityInputs,
	skills: readonly IdentitySkill[],
): string {
	const lines = [
		`# ${inputs.slug}: depth`,
		"",
		"Read this when something uncommon comes up. It says how your work is checked and measured.",
		"",
		...inputs.roles.flatMap((r) => {
			const d = ROLE_DEFINITIONS[r];
			return [
				`## ${roleHeading(r)}`,
				"",
				...(d.checkedBy ? [`Checked by: ${d.checkedBy}`] : []),
				`Measured by: ${d.measuredBy}`,
				"",
			];
		}),
		...skills.flatMap((s) => [
			`## Skill: ${s.name} (\`${s.slug}\`)`,
			"",
			s.contentMd.trim(),
			"",
			...(s.avelEnhancementMd
				? ["### AVEL additions", "", s.avelEnhancementMd.trim(), ""]
				: []),
		]),
	];
	return lines.join("\n");
}

/**
 * Generates both files, or refuses: an agent holding a role that is not a
 * model role gets no identity (the operator's foundations), and a file over
 * the cap is never produced. Same source, same bytes, same hash.
 */
export function generateIdentity(
	source: IdentitySource,
): GeneratedIdentity | IdentityRefusal {
	const inputs = identityInputs(source);
	if (!identitySupported(inputs.roles)) {
		return { refused: "identity_role_unsupported", roles: inputs.roles };
	}
	const skills = approvedSkills(source);
	const identityMd = renderIdentity(inputs, skills);
	const depthMd = renderDepth(inputs, skills);
	const identityTokens = estimateTokens(identityMd);
	const depthTokens = estimateTokens(depthMd);
	if (identityTokens > IDENTITY_TOKEN_CAP) {
		return {
			refused: "identity_over_token_cap",
			file: "identity",
			tokens: identityTokens,
			cap: IDENTITY_TOKEN_CAP,
		};
	}
	if (depthTokens > IDENTITY_TOKEN_CAP) {
		return {
			refused: "identity_over_token_cap",
			file: "depth",
			tokens: depthTokens,
			cap: IDENTITY_TOKEN_CAP,
		};
	}
	return {
		identityMd,
		depthMd,
		sha256: identitySha256(identityMd, depthMd),
		identityTokens,
		depthTokens,
		inputs,
		skippedSkills: skillOrder(source.roleSkills)
			.filter((s) => s.status !== "approved")
			.map((s) => ({ id: s.id, slug: s.slug, status: s.status })),
	};
}
