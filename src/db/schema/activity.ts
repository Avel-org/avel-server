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
import { engagement } from "./agency";
import { user } from "./auth";
import { id } from "./columns";
import { mission, rosterEntry } from "./work";

export const actorKind = pgEnum("actor_kind", ["operator", "system", "agent"]);

/**
 * Closed vocabulary. An action enters this list in the same change as the
 * mutation that writes it, so it holds only what module 0 writes.
 * The prefix is a domain, not the entity_type.
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
]);

export const activityEntityType = pgEnum("activity_entity_type", [
	"client",
	"engagement",
	"user",
	"connection",
	"mission",
	"export",
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
		action: activityAction("action").notNull(),
		entityType: activityEntityType("entity_type").notNull(),
		entityId: uuid("entity_id").notNull(),
		missionId: uuid("mission_id").references(() => mission.id),
		engagementId: uuid("engagement_id").references(() => engagement.id),
		requestId: text("request_id").notNull(),
		payload: jsonb("payload").notNull(),
	},
	(t) => [
		index("activity_log_entity_idx").on(t.entityType, t.entityId),
		index("activity_log_mission_id_idx").on(t.missionId),
		index("activity_log_engagement_id_idx").on(t.engagementId),
		index("activity_log_at_idx").on(t.at),
		check(
			"activity_log_operator_has_user",
			sql`(${t.actorKind} = 'operator') = (${t.actorUserId} is not null)`,
		),
		check(
			"activity_log_agent_has_roster_entry",
			sql`(${t.actorKind} = 'agent') = (${t.actorRosterEntryId} is not null)`,
		),
	],
);

export const activityLogInsert = createInsertSchema(activityLog);
export const activityLogSelect = createSelectSchema(activityLog);
