import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { pageMeta, pageQuery } from "./shared/pagination";
import { oneOrMany } from "./shared/query";

const c = initContract();

/** Must equal the actor_kind pgEnum; tests/api/activity.test.ts checks it. */
/** Canon, the project briefer, is named by its session, never as "system" (2026-10-19). */
export const activityActorKind = z.enum([
	"operator",
	"system",
	"agent",
	"canon",
]);

/** Must equal the activity_action pgEnum; tests/api/activity.test.ts checks it. */
export const activityAction = z.enum([
	"client.created",
	"client.updated",
	"engagement.created",
	"engagement.updated",
	"engagement.closed",
	"auth.signed_in",
	"connection.revoked",
	"mission.created",
	"mission.status_changed",
	"export.created",
	"export.status_changed",
	"intake.created",
	"intake.updated",
	"intake.proposed",
	"intake.approved",
	"intake.rejected",
	"skill_source.created",
	"skill_source.updated",
	"skill_source.deleted",
	"skill.created",
	"skill.updated",
	"skill.approved",
	"skill.retired",
	"skill.roles_set",
	"roster.entry_added",
	"roster.entry_updated",
	"roster.entry_removed",
	"roster.preset_applied",
	"mission.skill_attached",
	"mission.skill_detached",
	"intake.repo_read",
	"connection.created",
	"preset.created",
	"preset.updated",
	"mission.plan_updated",
	"playbook.created",
	"playbook.updated",
	"agent_template.updated",
	"agent_template.identity_regenerated",
	"dispatch.created",
	"dispatch.started",
	"dispatch.soft_ceiling_crossed",
	"dispatch.halted",
	"dispatch.closed",
	"completion_report.filed",
	"finding.opened",
	"file.uploaded",
	"file.purged",
	"mission.gate_run",
	"finding.confirmed",
	"finding.dismissed",
	"canon_session.opened",
	"canon_session.closed",
	"canon_session.halted",
	"canon_question.asked",
	"canon_question.answered",
	"canon_question.acknowledged",
	"canon_question.dismissed",
	"client_memory.proposed",
	"client_memory.kept",
	"client_memory.edited",
	"client_memory.removed",
	"client_memory.written",
	"intake.drafted_by_canon",
	"mission.spend_ceiling_set",
	"canon_session.reopened",
	"canon_session.archived",
	"canon_session.unarchived",
	"canon_session.renamed",
	"canon_message.posted",
	"agent_template.created",
	"mission.gate_queued",
	"mission.gate_failed",
	"repo_policy.set",
	"finding.check_set",
	"proposal.approved",
	"proposal.dismissed",
]);

/** Must equal the activity_entity_type pgEnum; tests/api/activity.test.ts checks it. */
export const activityEntityType = z.enum([
	"client",
	"engagement",
	"user",
	"connection",
	"mission",
	"export",
	"intake",
	"skill_source",
	"skill",
	"roster_entry",
	"roster_preset",
	"playbook",
	"agent_template",
	"dispatch",
	"completion_report",
	"finding",
	"canon_session",
	"canon_question",
	"client_memory",
	"file",
	"repo_policy",
	"proposal",
]);

export type ActivityActorKind = z.infer<typeof activityActorKind>;
export type ActivityAction = z.infer<typeof activityAction>;
export type ActivityEntityType = z.infer<typeof activityEntityType>;

const iso = z.string().datetime();
const uuid = z.string().uuid();

/** The agent behind an agent row: its template and the entry's territory. */
export const activityAgent = z.object({
	templateId: uuid,
	slug: z.string(),
	name: z.string(),
	territory: z.string().nullable(),
});

/** Who acted: the one actor shape every activity read returns. */
export const activityActor = z.object({
	kind: activityActorKind,
	/** Set exactly when kind is operator. */
	userId: uuid.nullable(),
	/** Set exactly when kind is agent. */
	rosterEntryId: uuid.nullable(),
	/** Set exactly when kind is canon. */
	canonSessionId: uuid.nullable(),
	display: z.string(),
	/** Set exactly when kind is agent, even after the entry or template is removed. */
	agent: activityAgent.nullable(),
});

export type ActivityActor = z.infer<typeof activityActor>;

/** One ActivityLog row: its columns in camelCase, plus the actor's label. */
export const activityEntry = z.object({
	id: uuid,
	at: iso,
	actorKind: activityActorKind,
	/** Set exactly when actorKind is operator. */
	actorUserId: uuid.nullable(),
	/** Set exactly when actorKind is agent. */
	actorRosterEntryId: uuid.nullable(),
	/** Set exactly when actorKind is canon. */
	actorCanonSessionId: uuid.nullable(),
	action: activityAction,
	entityType: activityEntityType,
	entityId: uuid,
	missionId: uuid.nullable(),
	engagementId: uuid.nullable(),
	/** The request that wrote the row; a system job's run or job id. */
	requestId: z.string(),
	payload: z.record(z.string(), z.unknown()),
	/**
	 * Who acted, for display. An operator is their GitHub login, the system is
	 * "AVEL runner", Canon is "Canon", and an agent is "Name · territory" from its RosterEntry
	 * and AgentTemplate, or the bare name when the entry has no territory.
	 */
	actor: activityActor,
});

export type ActivityEntry = z.infer<typeof activityEntry>;

/**
 * Every filter narrows; together they AND. The cursor is a position in
 * (at desc, id desc), not bound to the filters: sent with other filters, it
 * returns the rows those filters keep that come after the position.
 */
export const activityListQuery = pageQuery.extend({
	missionId: uuid.optional(),
	engagementId: uuid.optional(),
	/**
	 * Rows on the client itself, or on any of its engagements or their
	 * missions, deleted ones included: the rows Client.lastActivityAt reads.
	 */
	clientId: uuid.optional(),
	entityType: activityEntityType.optional(),
	/** One id, or up to 100 repeated or indexed: rows on any of them. */
	entityId: oneOrMany(uuid)
		.refine((ids) => ids.length <= 100, { message: "At most 100 entity ids" })
		.optional(),
	actorKind: activityActorKind.optional(),
});

export const activityListMeta = pageMeta.extend({
	/** The exact number of rows the filters keep, ignoring the cursor. Always present on this route. */
	total: z.number().int().nonnegative(),
});

export const activityListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(activityEntry),
	meta: activityListMeta,
});

export const activityContract = c.router({
	list: {
		method: "GET",
		path: "/api/activity",
		query: activityListQuery,
		responses: { 200: activityListEnvelope },
		summary: "ActivityLog rows, newest first",
	},
});
