import { isNull, sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { user } from "./auth";
import { id, softDelete, timestamps } from "./columns";
import { role } from "./enums";
import { skillSource } from "./platform";
import { mission } from "./work";

export const skillLayer = pgEnum("skill_layer", ["role", "stack", "domain"]);
export const skillType = pgEnum("skill_type", ["knowledge", "capability"]);
export const skillStatus = pgEnum("skill_status", [
	"draft",
	"approved",
	"retired",
]);
export const missionSkillSource = pgEnum("mission_skill_source", [
	"template",
	"pack",
	"client",
	"manual",
]);

export interface IoShape {
	reads: "large" | "small";
	returns: "large" | "small";
}

/**
 * One table, two types. A capability carries grants and io_shape; a knowledge
 * skill carries neither. The CHECK makes that a property of the row.
 *
 * content_sha256 covers description, content_md, grants, avel_enhancement_md,
 * io_shape, type and layer: anything that changes behavior. App code computes it.
 */
export const skill = pgTable(
	"skill",
	{
		...id,
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description").notNull(),
		contentMd: text("content_md").notNull(),
		avelEnhancementMd: text("avel_enhancement_md"),
		layer: skillLayer("layer").notNull(),
		type: skillType("type").notNull(),
		grants: text("grants").array(),
		ioShape: jsonb("io_shape").$type<IoShape>(),
		recommendedFor: role("recommended_for").array().notNull(),
		sourceId: uuid("source_id")
			.notNull()
			.references(() => skillSource.id),
		contentSha256: text("content_sha256").notNull(),
		status: skillStatus("status").notNull(),
		reviewedBy: uuid("reviewed_by").references(() => user.id),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
		version: integer("version").notNull(),
		...softDelete,
		...timestamps,
	},
	(t) => [
		uniqueIndex("skill_slug_live_uq").on(t.slug).where(isNull(t.deletedAt)),
		index("skill_source_id_idx").on(t.sourceId),
		check(
			"skill_capability_fields",
			sql`(${t.type} = 'capability' and ${t.grants} is not null and ${t.ioShape} is not null)
				or (${t.type} = 'knowledge' and ${t.grants} is null and ${t.ioShape} is null)`,
		),
	],
);

/** role → skill, for role-layer skills. */
export const roleSkills = pgTable(
	"role_skills",
	{
		role: role("role").notNull(),
		skillId: uuid("skill_id")
			.notNull()
			.references(() => skill.id),
	},
	(t) => [
		primaryKey({ columns: [t.role, t.skillId] }),
		index("role_skills_skill_id_idx").on(t.skillId),
	],
);

/** mission → skill, for stack- and domain-layer skills. */
export const missionSkills = pgTable(
	"mission_skills",
	{
		missionId: uuid("mission_id")
			.notNull()
			.references(() => mission.id),
		skillId: uuid("skill_id")
			.notNull()
			.references(() => skill.id),
		source: missionSkillSource("source").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.missionId, t.skillId] }),
		index("mission_skills_skill_id_idx").on(t.skillId),
	],
);

export const skillInsert = createInsertSchema(skill);
export const skillSelect = createSelectSchema(skill);
export const roleSkillsInsert = createInsertSchema(roleSkills);
export const roleSkillsSelect = createSelectSchema(roleSkills);
export const missionSkillsInsert = createInsertSchema(missionSkills);
export const missionSkillsSelect = createSelectSchema(missionSkills);
