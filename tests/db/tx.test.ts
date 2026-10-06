import { asc, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client";
import { withTx } from "../../src/db/tx";

// A real table, not a temp one: commit and rollback have to be visible from
// a different pooled connection than the one that wrote.
// Named per process: two suites on one database must not drop each other's table.
const table = `tx_probe_${process.pid}`;
const probe = pgTable(table, { name: text("name").primaryKey() });

class Boom extends Error {}

const names = async () =>
	(await getDb().select().from(probe).orderBy(asc(probe.name))).map(
		(r) => r.name,
	);

describe.skipIf(!process.env.DATABASE_URL)("withTx()", () => {
	beforeAll(async () => {
		await getDb().execute(sql`drop table if exists ${sql.identifier(table)}`);
		await getDb().execute(
			sql`create table ${sql.identifier(table)} (name text primary key)`,
		);
	});

	afterAll(async () => {
		await getDb().execute(sql`drop table if exists ${sql.identifier(table)}`);
		await closeDb();
	});

	it("commits when the function returns, and passes its value through", async () => {
		const out = await withTx(getDb(), async (tx) => {
			await tx.insert(probe).values({ name: "committed" });
			return 42;
		});
		expect(out).toBe(42);
		expect(await names()).toContain("committed");
	});

	it("rolls back every write when the function throws", async () => {
		await expect(
			withTx(getDb(), async (tx) => {
				await tx.insert(probe).values({ name: "mutation" });
				await tx.insert(probe).values({ name: "activity-log" });
				throw new Boom();
			}),
		).rejects.toBeInstanceOf(Boom);

		const after = await names();
		expect(after).not.toContain("mutation");
		expect(after).not.toContain("activity-log");
	});

	it("nests as a savepoint: an inner failure undoes only the inner writes", async () => {
		await withTx(getDb(), async (outer) => {
			await outer.insert(probe).values({ name: "outer" });
			await expect(
				withTx(outer, async (inner) => {
					await inner.insert(probe).values({ name: "inner" });
					throw new Boom();
				}),
			).rejects.toBeInstanceOf(Boom);
		});

		const after = await names();
		expect(after).toContain("outer");
		expect(after).not.toContain("inner");
	});
});
