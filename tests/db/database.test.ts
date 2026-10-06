import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client";

// Skips cleanly without a database, because getDb() connects inside the test,
// not while the file loads. CI provides a database, so there these run.
describe.skipIf(!process.env.DATABASE_URL)("the database", () => {
	afterAll(closeDb);

	it("connects and answers a query", async () => {
		const rows = await getDb().execute(sql`select 1 as one`);
		expect(rows[0]).toEqual({ one: 1 });
	});
});
