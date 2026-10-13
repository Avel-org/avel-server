import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Role } from "../contract/agent-template";
import type { Clock } from "../lib/clock";
import {
	type GeneratedIdentity,
	generateIdentity,
	type IdentityInputField,
	type IdentityRefusal,
	type IdentitySkill,
	type IdentitySource,
	identityInputs,
	staleInputs,
} from "../lib/identity";
import type { IdGenerator } from "../lib/ids";
import {
	agentIdentityVersion,
	agentTemplate,
	roleSkills,
	skill,
} from "./schema";
import { live } from "./schema/columns";
import type { Executor, Tx } from "./tx";

/**
 * Generated identities of agent templates (module 5). A version is
 * append-only (drizzle/0023), so a number or a sha always names the same
 * text. Routes log the activity; nothing here writes ActivityLog.
 */

export type IdentityVersion = typeof agentIdentityVersion.$inferSelect;

/**
 * version is the template's current identity: the version whose sha equals
 * what the generator would write now, if one exists, else the latest. A
 * template with no versions is not stale ("never generated"), and neither is
 * one the generator refuses for its roles (the operator).
 */
export type IdentityState = {
	version: IdentityVersion | null;
	stale: boolean;
	staleInputs: IdentityInputField[];
};

type TemplateRow = Pick<
	typeof agentTemplate.$inferSelect,
	"id" | "slug" | "name" | "kind" | "roles" | "writablePaths"
>;

const templateColumns = {
	id: agentTemplate.id,
	slug: agentTemplate.slug,
	name: agentTemplate.name,
	kind: agentTemplate.kind,
	roles: agentTemplate.roles,
	writablePaths: agentTemplate.writablePaths,
};

async function liveTemplates(
	db: Executor,
	templateIds: readonly string[],
): Promise<TemplateRow[]> {
	if (templateIds.length === 0) return [];
	return db
		.select(templateColumns)
		.from(agentTemplate)
		.where(
			and(live(agentTemplate), inArray(agentTemplate.id, [...templateIds])),
		)
		.orderBy(asc(agentTemplate.id));
}

/**
 * Every live skill role_skills attaches to any of these roles, whatever its
 * status: the generator writes in approved ones and reports the rest.
 */
async function roleSkillsFor(
	db: Executor,
	roles: readonly Role[],
): Promise<{ role: Role; skill: IdentitySkill }[]> {
	if (roles.length === 0) return [];
	return db
		.select({
			role: roleSkills.role,
			skill: {
				id: skill.id,
				slug: skill.slug,
				name: skill.name,
				description: skill.description,
				contentMd: skill.contentMd,
				avelEnhancementMd: skill.avelEnhancementMd,
				contentSha256: skill.contentSha256,
				status: skill.status,
			},
		})
		.from(roleSkills)
		.innerJoin(skill, eq(skill.id, roleSkills.skillId))
		.where(and(live(skill), inArray(roleSkills.role, [...roles])))
		.orderBy(asc(roleSkills.role), asc(skill.id));
}

function toSource(
	t: TemplateRow,
	attached: readonly { role: Role; skill: IdentitySkill }[],
): IdentitySource {
	const held = new Set(t.roles);
	return {
		slug: t.slug,
		name: t.name,
		kind: t.kind,
		roles: t.roles,
		writablePaths: t.writablePaths,
		roleSkills: attached.filter((a) => held.has(a.role)).map((a) => a.skill),
	};
}

/** Sources for the live templates among these ids, in two queries. */
async function identitySources(
	db: Executor,
	templateIds: readonly string[],
): Promise<Map<string, IdentitySource>> {
	const templates = await liveTemplates(db, templateIds);
	const roles = [...new Set(templates.flatMap((t) => t.roles))];
	const attached = await roleSkillsFor(db, roles);
	return new Map(templates.map((t) => [t.id, toSource(t, attached)]));
}

/** What the generator reads for a live template; null if there is none. */
export async function identitySourceFor(
	db: Executor,
	templateId: string,
): Promise<IdentitySource | null> {
	return (await identitySources(db, [templateId])).get(templateId) ?? null;
}

/** A template's versions, newest first. */
export async function versionsFor(
	db: Executor,
	templateId: string,
): Promise<IdentityVersion[]> {
	return db
		.select()
		.from(agentIdentityVersion)
		.where(eq(agentIdentityVersion.agentTemplateId, templateId))
		.orderBy(desc(agentIdentityVersion.number));
}

export async function versionByNumber(
	db: Executor,
	templateId: string,
	number: number,
): Promise<IdentityVersion | null> {
	const [row] = await db
		.select()
		.from(agentIdentityVersion)
		.where(
			and(
				eq(agentIdentityVersion.agentTemplateId, templateId),
				eq(agentIdentityVersion.number, number),
			),
		);
	return row ?? null;
}

/**
 * Every version with this sha, oldest first. The sha is unique within a
 * template but not across them (drizzle/0023), so this is a list.
 */
export async function versionsBySha(
	db: Executor,
	sha256: string,
): Promise<IdentityVersion[]> {
	return db
		.select()
		.from(agentIdentityVersion)
		.where(eq(agentIdentityVersion.sha256, sha256))
		.orderBy(asc(agentIdentityVersion.createdAt), asc(agentIdentityVersion.id));
}

const REF = /^(.+)@v([1-9][0-9]{0,9})$/;
const MAX_NUMBER = 2147483647;

/** Splits a display ref, `slug@vN` such as atlas@v3; null if it is not one. */
export function parseVersionRef(
	ref: string,
): { slug: string; number: number } | null {
	const m = REF.exec(ref);
	if (!m) return null;
	const number = Number(m[2]);
	if (number > MAX_NUMBER) return null;
	return { slug: m[1] as string, number };
}

/** Resolves `slug@vN` against the live template with that slug. */
export async function versionByRef(
	db: Executor,
	ref: string,
): Promise<IdentityVersion | null> {
	const parsed = parseVersionRef(ref);
	if (!parsed) return null;
	const [t] = await db
		.select({ id: agentTemplate.id })
		.from(agentTemplate)
		.where(and(live(agentTemplate), eq(agentTemplate.slug, parsed.slug)));
	if (!t) return null;
	return versionByNumber(db, t.id, parsed.number);
}

function isRefusal(
	g: GeneratedIdentity | IdentityRefusal,
): g is IdentityRefusal {
	return "refused" in g;
}

/**
 * The current version among a template's versions (any order): the one whose
 * sha matches a fresh generation, else the highest number.
 */
function pickCurrent(
	versions: readonly IdentityVersion[],
	fresh: GeneratedIdentity | IdentityRefusal,
): IdentityVersion | null {
	if (!isRefusal(fresh)) {
		const match = versions.find((v) => v.sha256 === fresh.sha256);
		if (match) return match;
	}
	let latest: IdentityVersion | null = null;
	for (const v of versions) if (!latest || v.number > latest.number) latest = v;
	return latest;
}

function stateOf(
	source: IdentitySource,
	versions: readonly IdentityVersion[],
): IdentityState {
	const fresh = generateIdentity(source);
	const version = pickCurrent(versions, fresh);
	const unsupported =
		isRefusal(fresh) && fresh.refused === "identity_role_unsupported";
	if (!version || unsupported) {
		return { version, stale: false, staleInputs: [] };
	}
	if (!isRefusal(fresh) && fresh.sha256 === version.sha256) {
		return { version, stale: false, staleInputs: [] };
	}
	return {
		version,
		stale: true,
		staleInputs: staleInputs(version.inputs, identityInputs(source)),
	};
}

/**
 * Identity state for each live template among these ids, in three queries
 * however many ids: templates, role skills, versions. A deleted or unknown
 * id is absent from the map.
 */
export async function identityStates(
	db: Executor,
	templateIds: readonly string[],
): Promise<Map<string, IdentityState>> {
	const sources = await identitySources(db, templateIds);
	if (sources.size === 0) return new Map();
	const rows = await db
		.select()
		.from(agentIdentityVersion)
		.where(inArray(agentIdentityVersion.agentTemplateId, [...sources.keys()]))
		.orderBy(
			asc(agentIdentityVersion.agentTemplateId),
			asc(agentIdentityVersion.number),
		);
	const byTemplate = new Map<string, IdentityVersion[]>();
	for (const r of rows) {
		const list = byTemplate.get(r.agentTemplateId) ?? [];
		list.push(r);
		byTemplate.set(r.agentTemplateId, list);
	}
	const states = new Map<string, IdentityState>();
	for (const [id, source] of sources) {
		states.set(id, stateOf(source, byTemplate.get(id) ?? []));
	}
	return states;
}

export async function identityState(
	db: Executor,
	templateId: string,
): Promise<IdentityState | null> {
	return (await identityStates(db, [templateId])).get(templateId) ?? null;
}

/** The current version (see IdentityState), or null if there is none. */
export async function currentIdentity(
	db: Executor,
	templateId: string,
): Promise<IdentityVersion | null> {
	return (await identityState(db, templateId))?.version ?? null;
}

export type RegenerateResult =
	| IdentityRefusal
	| { created: true; version: IdentityVersion }
	| { created: false; version: IdentityVersion; reused?: true };

/**
 * Generates the template's identity and records it if it is new. The same
 * sha as the latest version writes nothing; the sha of an older version
 * (A, B, then A again) writes nothing and returns that version with
 * reused: true. Otherwise the next number is inserted. The template row is
 * locked first, so two regenerations cannot race for a number. Null when no
 * live template has this id.
 */
export async function regenerateIdentity(
	tx: Tx,
	templateId: string,
	deps: { clock: Clock; ids: IdGenerator; operatorId: string | null },
): Promise<RegenerateResult | null> {
	const [locked] = await tx
		.select({ id: agentTemplate.id })
		.from(agentTemplate)
		.where(and(live(agentTemplate), eq(agentTemplate.id, templateId)))
		.for("update");
	if (!locked) return null;
	const source = await identitySourceFor(tx, templateId);
	if (!source) return null;
	const generated = generateIdentity(source);
	if (isRefusal(generated)) return generated;

	const versions = await versionsFor(tx, templateId);
	const latest = versions[0];
	const match = versions.find((v) => v.sha256 === generated.sha256);
	if (match) {
		return match === latest
			? { created: false, version: match }
			: { created: false, version: match, reused: true };
	}
	const [version] = await tx
		.insert(agentIdentityVersion)
		.values({
			id: deps.ids.next(),
			agentTemplateId: templateId,
			number: (latest?.number ?? 0) + 1,
			identityMd: generated.identityMd,
			depthMd: generated.depthMd,
			sha256: generated.sha256,
			identityTokens: generated.identityTokens,
			depthTokens: generated.depthTokens,
			inputs: generated.inputs,
			generatedBy: deps.operatorId,
			createdAt: deps.clock.now(),
		})
		.returning();
	return { created: true, version: version as IdentityVersion };
}
