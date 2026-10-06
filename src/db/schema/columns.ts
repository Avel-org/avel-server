import { isNull, type SQL } from "drizzle-orm";
import { type AnyPgColumn, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Clock } from "../../lib/clock";

/**
 * Shared columns. Spread them into a table: `pgTable("skill", { ...id, ...timestamps, ...softDelete, ... })`.
 *
 * None of them has a database default. The write path supplies every value
 * from the injected IdGenerator and Clock, and because the columns are
 * NOT NULL with no default, Drizzle's insert type makes each one required.
 * Forgetting the clock is a type error, not a row stamped by the database's
 * own clock that no golden test can reproduce.
 */

/** Primary key. The value comes from src/lib/ids.ts. */
export const id = {
	id: uuid("id").primaryKey(),
};

const at = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

/** Set both from `stamp(clock)` on insert, and `updatedAt` from `touch(clock)` on update. */
export const timestamps = {
	createdAt: at("created_at").notNull(),
	updatedAt: at("updated_at").notNull(),
};

/** Soft delete, for anything an Export can reach. Read it back only through `live()`. */
export const softDelete = {
	deletedAt: at("deleted_at"),
};

export function stamp(clock: Clock) {
	const now = clock.now();
	return { createdAt: now, updatedAt: now };
}

export function touch(clock: Clock) {
	return { updatedAt: clock.now() };
}

export function remove(clock: Clock) {
	const now = clock.now();
	return { deletedAt: now, updatedAt: now };
}

/**
 * The rows that are not soft-deleted. Drizzle has no middleware, so this is
 * never implicit: every list query over a soft-deletable table calls it.
 *
 *   db.select().from(skill).where(and(live(skill), eq(skill.slug, slug)))
 */
export function live(table: { deletedAt: AnyPgColumn }): SQL {
	return isNull(table.deletedAt);
}
