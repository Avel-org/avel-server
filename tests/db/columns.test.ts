import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { describe, expect, it } from "vitest";
import {
	id,
	remove,
	softDelete,
	stamp,
	timestamps,
	touch,
} from "../../src/db/schema/columns";
import { fixedClock } from "../../src/lib/clock";

// Needs no database: it checks the column helpers through drizzle-zod, the way
// entity tables will derive their Zod shapes.
const thing = pgTable("thing", {
	...id,
	...timestamps,
	...softDelete,
	name: text("name").notNull(),
});

const clock = fixedClock("2026-10-05T12:00:00.000Z");
const at = new Date("2026-10-05T12:00:00.000Z");
const validId = "00000000-0000-4000-8000-000000000001";

describe("shared columns", () => {
	it("use snake_case database names", () => {
		expect(thing.id.name).toBe("id");
		expect(thing.createdAt.name).toBe("created_at");
		expect(thing.updatedAt.name).toBe("updated_at");
		expect(thing.deletedAt.name).toBe("deleted_at");
	});

	it("have no database defaults, so the write path must supply id and time", () => {
		expect(thing.id.hasDefault).toBe(false);
		expect(thing.createdAt.hasDefault).toBe(false);
		expect(thing.updatedAt.hasDefault).toBe(false);

		const insert = createInsertSchema(thing);
		expect(insert.safeParse({ name: "x" }).success).toBe(false);
		expect(insert.safeParse({ id: validId, name: "x" }).success).toBe(false);
		expect(
			insert.safeParse({ id: validId, name: "x", ...stamp(clock) }).success,
		).toBe(true);
	});

	it("derive a Zod shape that rejects an id that is not a uuid", () => {
		const insert = createInsertSchema(thing);
		expect(
			insert.safeParse({ id: "id-0001", name: "x", ...stamp(clock) }).success,
		).toBe(false);
	});

	it("leave deleted_at optional on insert and nullable on select", () => {
		const select = createSelectSchema(thing);
		const row = { id: validId, name: "x", ...stamp(clock), deletedAt: null };
		expect(select.parse(row)).toEqual(row);
	});

	// If a column ever gains a database default, a directive below goes unused
	// and `pnpm typecheck` fails.
	it("make id and both timestamps required in the insert type", () => {
		// @ts-expect-error createdAt and updatedAt are required
		const missingTime: typeof thing.$inferInsert = { id: validId, name: "x" };
		// @ts-expect-error id is required
		const missingId: typeof thing.$inferInsert = { name: "x", ...stamp(clock) };
		expect([missingTime, missingId]).toHaveLength(2);
	});

	it("take every timestamp from the injected clock", () => {
		expect(stamp(clock)).toEqual({ createdAt: at, updatedAt: at });
		expect(touch(clock)).toEqual({ updatedAt: at });
		expect(remove(clock)).toEqual({ deletedAt: at, updatedAt: at });
	});
});
