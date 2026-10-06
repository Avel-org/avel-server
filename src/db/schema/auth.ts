import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

/**
 * Better Auth's four tables, owned by src/auth/. The object keys are the field
 * names Better Auth reads and writes, so they must not be renamed; the column
 * names are snake_case.
 *
 * Ids come from the injected IdGenerator through Better Auth's generateId.
 * createdAt and updatedAt are written by Better Auth from its own clock, not
 * the injected one. None of these rows reaches a rendered export.
 *
 * Postgres reserves `user`: Drizzle quotes it, raw SQL must write "user".
 */

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

/** The User entity. `*_by` foreign keys elsewhere point at user.id. */
export const user = pgTable("user", {
	...id,
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").notNull(),
	image: text("image"),
	/** GitHub's numeric user id, as a string. The operator allowlist matches on it. */
	githubId: text("github_id").notNull().unique(),
	githubLogin: text("github_login").notNull(),
	...timestamps,
});

export const session = pgTable(
	"session",
	{
		...id,
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: at("expires_at").notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		...timestamps,
	},
	(t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
	"account",
	{
		...id,
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** The provider's id for the account: for GitHub, the same value as user.github_id. */
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		/** OAuth tokens are encrypted by Better Auth before they are written (encryptOAuthTokens). */
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: at("access_token_expires_at"),
		refreshTokenExpiresAt: at("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		...timestamps,
	},
	(t) => [
		index("account_user_id_idx").on(t.userId),
		uniqueIndex("account_provider_account_idx").on(t.providerId, t.accountId),
	],
);

export const verification = pgTable(
	"verification",
	{
		...id,
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: at("expires_at").notNull(),
		...timestamps,
	},
	(t) => [index("verification_identifier_idx").on(t.identifier)],
);
