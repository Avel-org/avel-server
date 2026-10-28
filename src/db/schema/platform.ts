import { isNull } from "drizzle-orm";
import {
	boolean,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { engagement } from "./agency";
import { id, softDelete, timestamps } from "./columns";
import { exportTargetKind } from "./enums";

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

export const connectionService = pgEnum("connection_service", ["github"]);
export const connectionScopeType = pgEnum("connection_scope_type", [
	"owner",
	"repo",
]);
export const connectionStatus = pgEnum("connection_status", [
	"active",
	"expired",
	"revoked",
]);
export const skillSourceKind = pgEnum("skill_source_kind", [
	"internal",
	"vendor",
	"community",
]);

/** credential_ref names where the token lives. The token itself is never stored. */
export const connection = pgTable(
	"connection",
	{
		...id,
		service: connectionService("service").notNull(),
		label: text("label").notNull(),
		scopeType: connectionScopeType("scope_type").notNull(),
		scopeValue: text("scope_value").notNull(),
		credentialRef: text("credential_ref").notNull(),
		status: connectionStatus("status").notNull(),
		// Nullable: AVEL's internal work uses connections with no client engagement.
		engagementId: uuid("engagement_id").references(() => engagement.id),
		expiresAt: at("expires_at"),
		lastRotatedAt: at("last_rotated_at"),
		revokedAt: at("revoked_at"),
		...softDelete,
		...timestamps,
	},
	(t) => [index("connection_engagement_id_idx").on(t.engagementId)],
);

/** A repo with no live policy row is treated as allow_direct_push_to_default = false. */
export const repoPolicy = pgTable(
	"repo_policy",
	{
		...id,
		repoUrl: text("repo_url").notNull(),
		label: text("label"),
		allowDirectPushToDefault: boolean("allow_direct_push_to_default")
			.notNull()
			.default(false),
		defaultTarget: exportTargetKind("default_target"),
		...softDelete,
		...timestamps,
	},
	(t) => [
		uniqueIndex("repo_policy_repo_url_live_uq")
			.on(t.repoUrl)
			.where(isNull(t.deletedAt)),
	],
);

/** Open catalog: a label that grows, so its rows are data, not an enum. */
export const skillSource = pgTable("skill_source", {
	...id,
	name: text("name").notNull(),
	kind: skillSourceKind("kind").notNull(),
	url: text("url"),
	license: text("license"),
	...softDelete,
	...timestamps,
});
