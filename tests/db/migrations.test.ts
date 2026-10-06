import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client";

// tests/db/global-setup.ts migrates the database before any file runs. This
// file only reads, so it cannot race the files running beside it.
// tests/db/migrate-from-empty.test.ts proves the migrations apply from nothing.

const journal = JSON.parse(
	readFileSync("drizzle/meta/_journal.json", "utf-8"),
) as { entries: { tag: string; when: number }[] };

describe.skipIf(!process.env.DATABASE_URL)("the test database", () => {
	afterAll(closeDb);

	it("has every migration in the journal applied, and no others", async () => {
		const rows = await getDb().execute(
			sql`select created_at from drizzle.__drizzle_migrations order by created_at`,
		);
		expect(rows.map((r) => Number(r.created_at))).toEqual(
			journal.entries.map((e) => e.when),
		);
	});

	it("has pgvector enabled", async () => {
		const rows = await getDb().execute(
			sql`select extname from pg_extension where extname = 'vector'`,
		);
		expect(rows.map((r) => r.extname)).toEqual(["vector"]);
	});
});
