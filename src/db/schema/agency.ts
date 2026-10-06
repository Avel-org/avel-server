import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { id, softDelete, timestamps } from "./columns";

export const clientStatus = pgEnum("client_status", ["active", "closed"]);
export const engagementStatus = pgEnum("engagement_status", [
	"active",
	"closed",
]);

export const client = pgTable("client", {
	...id,
	name: text("name").notNull(),
	status: clientStatus("status").notNull(),
	primaryContact: text("primary_contact"),
	notesMd: text("notes_md"),
	...softDelete,
	...timestamps,
});

export const engagement = pgTable(
	"engagement",
	{
		...id,
		clientId: uuid("client_id")
			.notNull()
			.references(() => client.id),
		name: text("name").notNull(),
		scopeMd: text("scope_md"),
		status: engagementStatus("status").notNull(),
		startedAt: timestamp("started_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
		...softDelete,
		...timestamps,
	},
	(t) => [index("engagement_client_id_idx").on(t.clientId)],
);

export const clientInsert = createInsertSchema(client);
export const clientSelect = createSelectSchema(client);
export const engagementInsert = createInsertSchema(engagement);
export const engagementSelect = createSelectSchema(engagement);
