import { asc, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client";
import {
	id,
	live,
	remove,
	softDelete,
	stamp,
	timestamps,
} from "../../src/db/schema/columns";
import { fixedClock } from "../../src/lib/clock";

// A throwaway table built from the shared columns. It exists only as a temp
// table inside one transaction that always rolls back.
const probe = pgTable("live_probe", {
	...id,
	...timestamps,
	...softDelete,
	name: text("name").notNull(),
});

class Rollback extends Error {}

describe.skipIf(!process.env.DATABASE_URL)("live()", () => {
	afterAll(closeDb);

	it("ignores soft-deleted rows", async () => {
		const clock = fixedClock("2026-10-05T12:00:00.000Z");
		let names: string[] = [];

		await expect(
			getDb().transaction(async (tx) => {
				await tx.execute(sql`
					create temp table live_probe (
						id uuid primary key,
						created_at timestamptz not null,
						updated_at timestamptz not null,
						deleted_at timestamptz,
						name text not null
					) on commit drop`);

				await tx.insert(probe).values([
					{
						id: "00000000-0000-4000-8000-000000000001",
						name: "kept",
						...stamp(clock),
					},
					{
						id: "00000000-0000-4000-8000-000000000002",
						name: "gone",
						...stamp(clock),
					},
					{
						id: "00000000-0000-4000-8000-000000000003",
						name: "also kept",
						...stamp(clock),
					},
				]);
				await tx
					.update(probe)
					.set(remove(clock))
					.where(sql`${probe.name} = 'gone'`);

				const rows = await tx
					.select()
					.from(probe)
					.where(live(probe))
					.orderBy(asc(probe.id));
				names = rows.map((r) => r.name);

				// Without live() the deleted row is still there; the filter is what hides it.
				const all = await tx.select().from(probe);
				expect(all).toHaveLength(3);
				throw new Rollback();
			}),
		).rejects.toBeInstanceOf(Rollback);

		expect(names).toEqual(["kept", "also kept"]);
	});
});
