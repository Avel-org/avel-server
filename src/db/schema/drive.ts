import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { client, engagement } from "./agency";
import { user } from "./auth";
import { id, softDelete, timestamps } from "./columns";
import { intake } from "./delivery";

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

// Not in the contract yet: no route renders it. When the Drive's routes
// arrive, the list moves to src/contract/shared and this enum is built from it.
export const fileScope = pgEnum("file_scope", [
	"general",
	"client",
	"engagement",
]);

/**
 * The Drive's one store (DATA-CONTRACTS-V2, *File*). client_id is the one-way
 * door: a general row (client_id null) is the agency's, and a client's row is
 * never readable under another client's scope. Row-level security enforces
 * that for the avel_app role (drizzle/0028_drive.sql); withClientScope in
 * src/db/tx.ts sets the scope.
 *
 * Deleting a file purges its bytes and keeps the row as a tombstone:
 * purged_at set, storage_key cleared.
 */
export const file = pgTable(
	"file",
	{
		...id,
		scope: fileScope("scope").notNull(),
		clientId: uuid("client_id").references(() => client.id),
		engagementId: uuid("engagement_id").references(() => engagement.id),
		name: text("name").notNull(),
		mime: text("mime").notNull(),
		bytes: integer("bytes").notNull(),
		sha256: text("sha256").notNull(),
		storageKey: text("storage_key"),
		uploadedBy: uuid("uploaded_by")
			.notNull()
			.references(() => user.id),
		purgedAt: at("purged_at"),
		...softDelete,
		...timestamps,
	},
	(t) => [
		index("file_client_id_idx").on(t.clientId),
		index("file_engagement_id_idx").on(t.engagementId),
		// An engagement's file carries that engagement's client, not another's.
		foreignKey({
			name: "file_engagement_client_fk",
			columns: [t.engagementId, t.clientId],
			foreignColumns: [engagement.id, engagement.clientId],
		}),
		check(
			"file_scope_client",
			sql`(${t.scope} = 'general') = (${t.clientId} is null)`,
		),
		check(
			"file_scope_engagement",
			sql`(${t.scope} = 'engagement') = (${t.engagementId} is not null)`,
		),
		check("file_name_present", sql`btrim(${t.name}) <> ''`),
		check("file_bytes_nonnegative", sql`${t.bytes} >= 0`),
		check("file_sha256_hex", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
		check(
			"file_purged_iff_no_storage_key",
			sql`(${t.purgedAt} is null) = (${t.storageKey} is not null)`,
		),
	],
);

/** intake → file: source material attached to an Intake. */
export const intakeFiles = pgTable(
	"intake_files",
	{
		intakeId: uuid("intake_id")
			.notNull()
			.references(() => intake.id),
		fileId: uuid("file_id")
			.notNull()
			.references(() => file.id),
	},
	(t) => [
		primaryKey({ columns: [t.intakeId, t.fileId] }),
		index("intake_files_file_id_idx").on(t.fileId),
	],
);

export const fileInsert = createInsertSchema(file);
export const fileSelect = createSelectSchema(file);
export const intakeFilesInsert = createInsertSchema(intakeFiles);
export const intakeFilesSelect = createSelectSchema(intakeFiles);
