import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
	type AccessOverride,
	accessFor,
	checkAccessOverrides,
	FIRM_ROLES,
	isMissionAttachable,
	type MissionSkill,
	ok,
	type Role,
	type RosterEntry,
	type RosterEntryFields,
	rosterContract,
	rosterEntryProblems,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	agentTemplate,
	mission,
	missionSkills,
	roleSkills,
	rosterEntry,
	rosterPreset,
	type StoredAccessOverride,
	skill,
	skillSource,
} from "../db/schema";
import { live, remove, stamp, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
} from "./shared";
import { skillListColumns, toSkillListItem } from "./skills";

async function requireLiveMission(db: Executor, id: string): Promise<void> {
	const [row] = await db
		.select({ id: mission.id })
		.from(mission)
		.where(and(eq(mission.id, id), live(mission)));
	if (!row) throw notFound("mission", id);
}

/**
 * The mission, locked FOR UPDATE for the rest of the transaction. Every
 * roster and mission-skill write goes through here, so writes to one
 * mission's roster run one at a time: the duplicate check and the
 * draft-only rule cannot be raced.
 */
async function lockDraftMission(tx: Tx, id: string) {
	const [row] = await tx
		.select({ status: mission.status, engagementId: mission.engagementId })
		.from(mission)
		.where(and(eq(mission.id, id), live(mission)))
		.for("update");
	if (!row) throw notFound("mission", id);
	if (row.status !== "draft") {
		throw new ApiError(
			"PRECONDITION_FAILED",
			`A ${row.status} mission's roster cannot change`,
			{ details: { reason: "mission_not_editable" } },
		);
	}
	return row;
}

type EntryRow = typeof rosterEntry.$inferSelect;
type TemplateRow = Pick<
	typeof agentTemplate.$inferSelect,
	"id" | "slug" | "name" | "kind" | "roles"
>;

const templateSummary = {
	id: agentTemplate.id,
	slug: agentTemplate.slug,
	name: agentTemplate.name,
	kind: agentTemplate.kind,
	roles: agentTemplate.roles,
};

const toStored = (o: AccessOverride): StoredAccessOverride => ({
	skill_id: o.skillId,
	grant: o.grant,
	mode: o.mode,
});

const fromStored = (o: StoredAccessOverride): AccessOverride => ({
	skillId: o.skill_id,
	grant: o.grant,
	mode: o.mode,
});

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
		accessOverrides: entry.accessOverrides?.map(fromStored) ?? null,
		createdAt: entry.createdAt.toISOString(),
		updatedAt: entry.updatedAt.toISOString(),
	};
}

/**
 * Live entries with their templates, oldest first. The template is joined
 * whether or not it is live: an entry made from a template deleted since
 * still names the agent it was.
 */
async function liveEntries(db: Executor, missionId: string, where?: SQL) {
	const rows = await db
		.select({ entry: rosterEntry, template: templateSummary })
		.from(rosterEntry)
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.where(and(eq(rosterEntry.missionId, missionId), live(rosterEntry), where))
		.orderBy(asc(rosterEntry.createdAt), asc(rosterEntry.id));
	return rows.map((r) => toWire(r.entry, r.template));
}

async function oneEntry(db: Executor, missionId: string, entryId: string) {
	const [entry] = await liveEntries(db, missionId, eq(rosterEntry.id, entryId));
	if (!entry) throw notFound("roster entry", entryId);
	return entry;
}

/** A live template that may sit on a mission roster, or a 422. */
function requireRosterable(
	template: { id: string; roles: Role[]; deletedAt: Date | null } | undefined,
	templateId: string,
) {
	if (!template || template.deletedAt !== null) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"The agent template does not exist",
			{ details: { reason: "agent_template_not_found" } },
		);
	}
	const firm = template.roles.filter((r) =>
		(FIRM_ROLES as readonly Role[]).includes(r),
	);
	if (firm.length > 0) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			`Template ${templateId} holds Firm roles (${firm.join(", ")}), which never sit on a mission roster`,
			{ details: { reason: "template_not_rosterable" } },
		);
	}
}

/**
 * A preset's agents, as applying them requires: each template live and
 * rosterable, and each template at most once per territory (no territory
 * counts as one). Preset create and update check the same before saving.
 */
export async function requirePresetAgents(
	db: Executor,
	agents: Array<{ agentTemplateId: string; territory: string | null }>,
) {
	const templateIds = [...new Set(agents.map((a) => a.agentTemplateId))];
	const templates =
		templateIds.length === 0
			? []
			: await db
					.select({
						id: agentTemplate.id,
						roles: agentTemplate.roles,
						deletedAt: agentTemplate.deletedAt,
					})
					.from(agentTemplate)
					.where(inArray(agentTemplate.id, templateIds));
	const byId = new Map(templates.map((t) => [t.id, t]));
	for (const id of templateIds) requireRosterable(byId.get(id), id);

	const seen = new Set<string>();
	for (const a of agents) {
		const key = JSON.stringify([a.agentTemplateId, a.territory]);
		if (seen.has(key)) {
			throw new ApiError(
				"CONFLICT",
				"The preset names one template twice for the same territory",
			);
		}
		seen.add(key);
	}
}

/** One live entry per template and territory on a mission (no territory counts as one). */
async function requireNoDuplicate(
	tx: Tx,
	missionId: string,
	agentTemplateId: string,
	territory: string | null,
	exceptId?: string,
) {
	const rows = await tx
		.select({ id: rosterEntry.id })
		.from(rosterEntry)
		.where(
			and(
				eq(rosterEntry.missionId, missionId),
				eq(rosterEntry.agentTemplateId, agentTemplateId),
				territory === null
					? isNull(rosterEntry.territory)
					: eq(rosterEntry.territory, territory),
				live(rosterEntry),
			),
		);
	if (rows.some((r) => r.id !== exceptId)) {
		throw new ApiError(
			"CONFLICT",
			territory === null
				? "This template is already on the roster with no territory"
				: `This template is already on the roster for territory ${territory}`,
		);
	}
}

/** The whole-entry rules, refused as a body problem (400). */
function requireValidEntry(fields: RosterEntryFields) {
	const problems = rosterEntryProblems(fields);
	if (problems.length > 0) {
		throw new ApiError("VALIDATION_FAILED", "The roster entry is not valid", {
			details: { body: problems },
		});
	}
}

/** DATA-CONTRACTS-V2, RosterEntry: soft 1.5× and hard 3× the estimate, where not given. */
function defaultCeilings(
	estimate: number | null,
	soft: number | null | undefined,
	hard: number | null | undefined,
) {
	return {
		tokenSoftCeiling:
			soft !== undefined
				? soft
				: estimate === null
					? null
					: Math.round(estimate * 1.5),
		tokenHardCeiling:
			hard !== undefined ? hard : estimate === null ? null : estimate * 3,
	};
}

/**
 * What accessFor needs for one entry, loaded narrowly: the template's roles
 * and paths, the role_skills rows for those roles, the mission's attached
 * skills, and only the live capability skills among them.
 */
async function entryAccessInput(
	db: Executor,
	missionId: string,
	agentTemplateId: string,
	writablePaths: string[] | null,
) {
	const [template] = await db
		.select({
			roles: agentTemplate.roles,
			writablePaths: agentTemplate.writablePaths,
		})
		.from(agentTemplate)
		.where(eq(agentTemplate.id, agentTemplateId));
	if (!template)
		throw new Error(`roster entry template ${agentTemplateId} is missing`);
	const viaRole =
		template.roles.length === 0
			? []
			: await db
					.select({ role: roleSkills.role, skillId: roleSkills.skillId })
					.from(roleSkills)
					.where(inArray(roleSkills.role, template.roles));
	const attached = await db
		.select({ skillId: missionSkills.skillId })
		.from(missionSkills)
		.where(eq(missionSkills.missionId, missionId));
	const ids = [
		...new Set([
			...viaRole.map((r) => r.skillId),
			...attached.map((a) => a.skillId),
		]),
	];
	const skills =
		ids.length === 0
			? []
			: await db
					.select({
						id: skill.id,
						slug: skill.slug,
						type: skill.type,
						layer: skill.layer,
						status: skill.status,
						recommendedFor: skill.recommendedFor,
						grants: skill.grants,
					})
					.from(skill)
					.where(
						and(
							inArray(skill.id, ids),
							eq(skill.type, "capability"),
							live(skill),
						),
					);
	return {
		roles: template.roles,
		writablePaths: writablePaths ?? template.writablePaths,
		skills,
		roleSkills: viaRole,
		missionSkillIds: attached.map((a) => a.skillId),
	};
}

/** The overrides to store, or a 422 against the tool rows accessFor derives now. */
async function requireValidOverrides(
	tx: Tx,
	missionId: string,
	agentTemplateId: string,
	writablePaths: string[] | null,
	overrides: AccessOverride[] | null,
): Promise<StoredAccessOverride[] | null> {
	if (overrides === null || overrides.length === 0) return null;
	const { rows } = accessFor(
		await entryAccessInput(tx, missionId, agentTemplateId, writablePaths),
	);
	const issues = checkAccessOverrides(rows, overrides);
	if (issues.length > 0) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"An access override names no tool row the agent has, repeats one, or widens one",
			{ details: { reason: "access_override_invalid", issues } },
		);
	}
	return overrides.map(toStored);
}

async function missionSkillList(
	db: Executor,
	missionId: string,
	where?: SQL,
): Promise<MissionSkill[]> {
	const rows = await db
		.select({ ...skillListColumns, attachedFrom: missionSkills.source })
		.from(missionSkills)
		.innerJoin(skill, eq(skill.id, missionSkills.skillId))
		.innerJoin(skillSource, eq(skillSource.id, skill.sourceId))
		.where(and(eq(missionSkills.missionId, missionId), live(skill), where))
		.orderBy(asc(skill.createdAt), asc(skill.id));
	return rows.map(({ attachedFrom, ...row }) => ({
		skill: toSkillListItem(row),
		source: attachedFrom,
	}));
}

export function rosterRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(rosterContract, {
		list: async ({ params }) => {
			const db = deps.db();
			await requireLiveMission(db, params.missionId);
			return {
				status: 200,
				body: ok(await liveEntries(db, params.missionId)),
			};
		},

		skills: async ({ params }) => {
			const db = deps.db();
			await requireLiveMission(db, params.missionId);
			return {
				status: 200,
				body: ok(await missionSkillList(db, params.missionId)),
			};
		},

		access: async ({ params }) => {
			const db = deps.db();
			await requireLiveMission(db, params.missionId);
			const [entry] = await db
				.select({
					agentTemplateId: rosterEntry.agentTemplateId,
					writablePaths: rosterEntry.writablePaths,
					accessOverrides: rosterEntry.accessOverrides,
				})
				.from(rosterEntry)
				.where(
					and(
						eq(rosterEntry.id, params.entryId),
						eq(rosterEntry.missionId, params.missionId),
						live(rosterEntry),
					),
				);
			if (!entry) throw notFound("roster entry", params.entryId);
			const access = accessFor({
				...(await entryAccessInput(
					db,
					params.missionId,
					entry.agentTemplateId,
					entry.writablePaths,
				)),
				overrides: entry.accessOverrides?.map(fromStored) ?? null,
			});
			return { status: 200, body: ok(access) };
		},

		add: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const { missionId } = params;
			const entry = await withTx(deps.db(), async (tx) => {
				const m = await lockDraftMission(tx, missionId);
				const [template] = await tx
					.select({
						id: agentTemplate.id,
						roles: agentTemplate.roles,
						waveDefaults: agentTemplate.waveDefaults,
						deletedAt: agentTemplate.deletedAt,
					})
					.from(agentTemplate)
					.where(eq(agentTemplate.id, body.agentTemplateId));
				requireRosterable(template, body.agentTemplateId);
				if (!template) throw new Error("unreachable: checked above");

				const estimatedTokens = body.estimatedTokens ?? null;
				const values = {
					id: deps.ids.next(),
					missionId,
					agentTemplateId: template.id,
					active: body.active ?? true,
					waves: body.waves ?? template.waveDefaults,
					customizedMd: body.customizedMd ?? null,
					writablePaths: body.writablePaths ?? null,
					territory: body.territory ?? null,
					estimatedTokens,
					...defaultCeilings(
						estimatedTokens,
						body.tokenSoftCeiling,
						body.tokenHardCeiling,
					),
					grain: body.grain ?? ("default" as const),
					absorbedBoundaries: body.absorbedBoundaries ?? [],
					...stamp(deps.clock),
				};
				requireValidEntry(values);
				await requireNoDuplicate(
					tx,
					missionId,
					values.agentTemplateId,
					values.territory,
				);
				await tx.insert(rosterEntry).values(values);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "roster.entry_added",
					entityType: "roster_entry",
					entityId: values.id,
					missionId,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload: {
						agentTemplateId: values.agentTemplateId,
						territory: values.territory,
					},
				});
				return oneEntry(tx, missionId, values.id);
			});
			return { status: 201, body: ok(entry) };
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const { missionId, entryId } = params;
			const entry = await withTx(deps.db(), async (tx) => {
				const m = await lockDraftMission(tx, missionId);
				const [current] = await tx
					.select()
					.from(rosterEntry)
					.where(
						and(
							eq(rosterEntry.id, entryId),
							eq(rosterEntry.missionId, missionId),
							live(rosterEntry),
						),
					);
				if (!current) throw notFound("roster entry", entryId);
				const { accessOverrides, ...fields } = body;
				const next = { ...current, ...fields };
				requireValidEntry(next);
				const stored =
					accessOverrides === undefined
						? undefined
						: await requireValidOverrides(
								tx,
								missionId,
								current.agentTemplateId,
								next.writablePaths,
								accessOverrides,
							);
				if (body.territory !== undefined) {
					await requireNoDuplicate(
						tx,
						missionId,
						current.agentTemplateId,
						next.territory,
						entryId,
					);
				}
				await tx
					.update(rosterEntry)
					.set({
						...fields,
						...(stored === undefined ? {} : { accessOverrides: stored }),
						...touch(deps.clock),
					})
					.where(eq(rosterEntry.id, entryId));
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "roster.entry_updated",
					entityType: "roster_entry",
					entityId: entryId,
					missionId,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					// Field names only: customizedMd can be 20 KB.
					payload: { fields: Object.keys(body).sort() },
				});
				return oneEntry(tx, missionId, entryId);
			});
			return { status: 200, body: ok(entry) };
		},

		remove: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const { missionId, entryId } = params;
			await withTx(deps.db(), async (tx) => {
				const m = await lockDraftMission(tx, missionId);
				const [removed] = await tx
					.update(rosterEntry)
					.set(remove(deps.clock))
					.where(
						and(
							eq(rosterEntry.id, entryId),
							eq(rosterEntry.missionId, missionId),
							live(rosterEntry),
						),
					)
					.returning({ id: rosterEntry.id });
				if (!removed) throw notFound("roster entry", entryId);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "roster.entry_removed",
					entityType: "roster_entry",
					entityId: entryId,
					missionId,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload: {},
				});
			});
			return { status: 200, body: ok({ id: entryId }) };
		},

		applyPreset: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const { missionId } = params;
			const entries = await withTx(deps.db(), async (tx) => {
				const m = await lockDraftMission(tx, missionId);
				const [preset] = await tx
					.select()
					.from(rosterPreset)
					.where(and(eq(rosterPreset.id, body.presetId), live(rosterPreset)));
				if (!preset) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The preset does not exist",
						{
							details: { reason: "preset_not_found" },
						},
					);
				}

				const existing = await tx
					.select({ id: rosterEntry.id })
					.from(rosterEntry)
					.where(and(eq(rosterEntry.missionId, missionId), live(rosterEntry)))
					.orderBy(asc(rosterEntry.createdAt), asc(rosterEntry.id));
				if (existing.length > 0 && !body.replace) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The mission already has a roster; send replace: true to replace it",
						{ details: { reason: "roster_not_empty" } },
					);
				}

				await requirePresetAgents(
					tx,
					preset.agents.map((a) => ({
						agentTemplateId: a.agent_template_id,
						territory: a.territory ?? null,
					})),
				);

				const values = preset.agents.map((a) => {
					const territory = a.territory ?? null;
					const estimatedTokens = a.estimated_tokens ?? null;
					const row = {
						id: deps.ids.next(),
						missionId,
						agentTemplateId: a.agent_template_id,
						active: true,
						waves: a.waves,
						customizedMd: null,
						writablePaths: a.writable_paths ?? null,
						territory,
						estimatedTokens,
						...defaultCeilings(estimatedTokens, undefined, undefined),
						grain: "default" as const,
						absorbedBoundaries: [],
						...stamp(deps.clock),
					};
					requireValidEntry(row);
					return row;
				});

				const base = {
					actorKind: "operator" as const,
					actorUserId: operator.id,
					missionId,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
				};
				if (existing.length > 0) {
					await tx
						.update(rosterEntry)
						.set(remove(deps.clock))
						.where(
							inArray(
								rosterEntry.id,
								existing.map((e) => e.id),
							),
						);
					for (const e of existing) {
						await logActivity(tx, deps, {
							...base,
							action: "roster.entry_removed",
							entityType: "roster_entry",
							entityId: e.id,
							payload: { presetId: preset.id },
						});
					}
				}
				if (values.length > 0) await tx.insert(rosterEntry).values(values);
				for (const v of values) {
					await logActivity(tx, deps, {
						...base,
						action: "roster.entry_added",
						entityType: "roster_entry",
						entityId: v.id,
						payload: {
							agentTemplateId: v.agentTemplateId,
							territory: v.territory,
							presetId: preset.id,
						},
					});
				}
				await logActivity(tx, deps, {
					...base,
					action: "roster.preset_applied",
					entityType: "mission",
					entityId: missionId,
					payload: {
						presetId: preset.id,
						presetVersion: preset.version,
						added: values.map((v) => v.id),
						removed: existing.map((e) => e.id),
					},
				});
				return liveEntries(tx, missionId);
			});
			return { status: 200, body: ok(entries) };
		},

		attachSkill: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const { missionId } = params;
			const attached = await withTx(deps.db(), async (tx) => {
				const m = await lockDraftMission(tx, missionId);
				// Locked for share: it cannot be retired or edited back to draft
				// between this check and the attach.
				const [target] = await tx
					.select({ status: skill.status, layer: skill.layer })
					.from(skill)
					.where(and(eq(skill.id, body.skillId), live(skill)))
					.for("share");
				if (!target) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The skill does not exist",
						{
							details: { reason: "skill_not_found" },
						},
					);
				}
				if (!isMissionAttachable(target)) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						`A ${target.status} ${target.layer}-layer skill cannot be attached to a mission`,
						{ details: { reason: "skill_not_attachable" } },
					);
				}
				const inserted = await tx
					.insert(missionSkills)
					.values({ missionId, skillId: body.skillId, source: "manual" })
					.onConflictDoNothing()
					.returning({ skillId: missionSkills.skillId });
				if (inserted.length === 0) {
					throw new ApiError("CONFLICT", "The skill is already on the mission");
				}
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.skill_attached",
					entityType: "mission",
					entityId: missionId,
					missionId,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload: { skillId: body.skillId, source: "manual" },
				});
				const [item] = await missionSkillList(
					tx,
					missionId,
					eq(skill.id, body.skillId),
				);
				return item;
			});
			if (!attached) throw new Error("an attached skill was not readable");
			return { status: 201, body: ok(attached) };
		},

		detachSkill: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const { missionId, skillId } = params;
			await withTx(deps.db(), async (tx) => {
				const m = await lockDraftMission(tx, missionId);
				const deleted = await tx
					.delete(missionSkills)
					.where(
						and(
							eq(missionSkills.missionId, missionId),
							eq(missionSkills.skillId, skillId),
						),
					)
					.returning({ source: missionSkills.source });
				const [row] = deleted;
				if (!row) throw notFound("mission skill", skillId);
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.skill_detached",
					entityType: "mission",
					entityId: missionId,
					missionId,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload: { skillId, source: row.source },
				});
			});
			return { status: 200, body: ok({ id: skillId }) };
		},
	});
}
