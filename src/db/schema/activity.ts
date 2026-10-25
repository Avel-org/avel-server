import { sql } from "drizzle-orm";
import {
	check,
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { client, engagement } from "./agency";
import { user } from "./auth";
import { canonSession } from "./canon";
import { id } from "./columns";
import { mission, rosterEntry } from "./work";

export const actorKind = pgEnum("actor_kind", [
	"operator",
	"system",
	"agent",
	// Canon, the project briefer: not a dispatch and not on a roster, so it is
	// named by its session (actor_canon_session_id). Added 2026-10-19.
	"canon",
]);

/**
 * Closed vocabulary. An action enters this list in the same change as the
 * mutation that writes it, so it holds only what built modules write.
 * The prefix is a domain, not the entity_type.
 *
 * Exception, 2026-10-13: the dispatch and completion_report values arrive
 * with module 6's contract step, before the routes that write them, so the
 * frontend's exhaustive maps get their copy in one pass.
 */
export const activityAction = pgEnum("activity_action", [
	"client.created",
	"client.updated",
	"engagement.created",
	"engagement.updated",
	"engagement.closed",
	"auth.signed_in",
	"connection.revoked",
	// Exception to "add with the mutation": the dev seed writes these before the
	// mission and export mutations exist, so lists have real activity to show.
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
]);

export const activityEntityType = pgEnum("activity_entity_type", [
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
]);

/**
 * Append-only. A trigger (drizzle/0007) refuses UPDATE, DELETE and TRUNCATE.
 * Rows are written through logActivity in src/db/activity.ts, inside the same
 * transaction as the mutation they record.
 */
export const activityLog = pgTable(
	"activity_log",
	{
		...id,
		at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
		actorKind: actorKind("actor_kind").notNull(),
		actorUserId: uuid("actor_user_id").references(() => user.id),
		actorRosterEntryId: uuid("actor_roster_entry_id").references(
			() => rosterEntry.id,
		),
		actorCanonSessionId: uuid("actor_canon_session_id").references(
			() => canonSession.id,
		),
		action: activityAction("action").notNull(),
		entityType: activityEntityType("entity_type").notNull(),
		entityId: uuid("entity_id").notNull(),
		missionId: uuid("mission_id").references(() => mission.id),
		engagementId: uuid("engagement_id").references(() => engagement.id),
		/**
		 * The client the row touches, set by logActivity (src/db/activity.ts)
		 * from the row's engagement, mission or client, or given by writers on
		 * a client's memory and Canon sessions, which have neither. Null for a
		 * row on no client. Internal: not on the wire. Added 2026-10-21, with
		 * a backfill of every older row (drizzle/0047).
		 */
		clientId: uuid("client_id").references(() => client.id),
		requestId: text("request_id").notNull(),
		payload: jsonb("payload").notNull(),
	},
	(t) => [
		index("activity_log_entity_idx").on(t.entityType, t.entityId),
		index("activity_log_mission_id_idx").on(t.missionId),
		index("activity_log_engagement_id_idx").on(t.engagementId),
		index("activity_log_at_idx").on(t.at),
		// Ascending on purpose: scanned backward it gives "at desc, id desc"
		// for a client's list and its max(at). A DESC NULLS LAST index (what
		// .desc() makes) cannot, and the planner skips it.
		index("activity_log_client_id_at_idx").on(t.clientId, t.at, t.id),
		index("activity_log_actor_canon_session_id_idx").on(t.actorCanonSessionId),
		// GET /api/presets/:id/applications (appliedFilter in
		// src/routes/presets.ts): its action and presetId as the range, in its
		// (at desc, id desc) order, so a page is one ordered index range. Only
		// rows whose payload names a preset; a query on presetId = x implies
		// that, even with x a parameter. Not partial on the action: an enum
		// literal is refused in a batch that also adds the value (55P04), and
		// action::text is not immutable, so no index predicate may use it.
		index("activity_log_preset_applied_idx")
			.on(
				t.action,
				sql`(${t.payload}->>'presetId')`,
				t.at.desc().nullsFirst(),
				t.id.desc().nullsFirst(),
			)
			.where(sql`(${t.payload}->>'presetId') is not null`),
		check(
			"activity_log_operator_has_user",
			sql`(${t.actorKind} = 'operator') = (${t.actorUserId} is not null)`,
		),
		check(
			"activity_log_agent_has_roster_entry",
			sql`(${t.actorKind} = 'agent') = (${t.actorRosterEntryId} is not null)`,
		),
		// Compared as text: 'canon' is added by the migration before this one,
		// and the migrator applies a batch in one transaction, where an enum
		// literal of an uncommitted value is refused ("unsafe use of new value").
		check(
			"activity_log_canon_has_session",
			sql`(${t.actorKind}::text = 'canon') = (${t.actorCanonSessionId} is not null)`,
		),
	],
);

export const activityLogInsert = createInsertSchema(activityLog);
export const activityLogSelect = createSelectSchema(activityLog);
