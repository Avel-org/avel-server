import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { MISSION_STATUSES } from "../../src/contract/shared/status";
import { assertDevDatabase, runSeed } from "../../src/db/seed";

// The seed runs against throwaway databases whose names end in _dev, because
// it refuses every other name. Creating, migrating and seeding a database is
// server-level work, so these tests carry the same budget as migrate-from-empty.
const url = process.env.DATABASE_URL;
const BUDGET_MS = 60_000;
const first = `avel_seed_a_${process.pid}_dev`;
const second = `avel_seed_b_${process.pid}_dev`;

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

/** Every row of the seeded tables, in a stable order, for comparing two runs. */
async function dump(dbUrl: string) {
	const conn = postgres(dbUrl, { max: 1, onnotice: () => {} });
	try {
		const out: Record<string, unknown[]> = {};
		for (const table of [
			"client",
			"engagement",
			"connection",
			"agent_template",
			"agent_identity_version",
			"roster_preset",
			"playbook",
			"mission",
			"roster_entry",
			"export",
			"activity_log",
			"skill_source",
			"skill",
		]) {
			out[table] = await conn.unsafe(`select * from "${table}" order by id`);
		}
		return out;
	} finally {
		await conn.end();
	}
}

describe.skipIf(!url)("pnpm db:seed", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;

	afterAll(async () => {
		for (const name of [first, second]) {
			await admin?.unsafe(`drop database if exists ${name} with (force)`);
		}
		await admin?.end();
	}, BUDGET_MS);

	async function freshDevDatabase(name: string) {
		if (!url || !admin) throw new Error("unreachable: suite is skipped");
		await admin.unsafe(`drop database if exists ${name} with (force)`);
		await admin.unsafe(`create database ${name}`);
		const dbUrl = withDatabase(url, name);
		const { drizzle } = await import("drizzle-orm/postgres-js");
		const { migrate } = await import("drizzle-orm/postgres-js/migrator");
		const conn = postgres(dbUrl, { max: 1, onnotice: () => {} });
		try {
			await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
		} finally {
			await conn.end();
		}
		return dbUrl;
	}

	it(
		"seeds once, then a second run changes nothing",
		async () => {
			const dbUrl = await freshDevDatabase(first);

			const run1 = await runSeed(dbUrl);
			expect(run1.status).toBe("seeded");
			expect(run1.counts.mission).toBeGreaterThanOrEqual(12);
			const before = await dump(dbUrl);

			const run2 = await runSeed(dbUrl);
			expect(run2.status).toBe("already-seeded");
			expect(run2.counts).toEqual(run1.counts);
			expect(await dump(dbUrl)).toEqual(before);
		},
		BUDGET_MS,
	);

	it(
		"is deterministic: two fresh databases get identical rows",
		async () => {
			const dbUrl = await freshDevDatabase(second);
			await runSeed(dbUrl);
			expect(await dump(dbUrl)).toEqual(
				await dump(withDatabase(url ?? "", first)),
			);
		},
		BUDGET_MS,
	);

	it(
		"covers every mission status and both origins, and soft-deletes one mission",
		async () => {
			const conn = postgres(withDatabase(url ?? "", first), {
				max: 1,
				onnotice: () => {},
			});
			try {
				const live = await conn<{ status: string; origin: string }[]>`
					select status, origin from mission where deleted_at is null`;
				expect(new Set(live.map((m) => m.status))).toEqual(
					new Set(MISSION_STATUSES),
				);
				expect(new Set(live.map((m) => m.origin))).toEqual(
					new Set(["client", "internal"]),
				);
				const deleted = await conn`
					select id from mission where deleted_at is not null`;
				expect(deleted).toHaveLength(1);
				const internalWithEngagement = await conn`
					select id from mission where origin = 'internal' and engagement_id is not null`;
				expect(internalWithEngagement).toHaveLength(0);
			} finally {
				await conn.end();
			}
		},
		BUDGET_MS,
	);

	it(
		"covers the export statuses the Missions page reads",
		async () => {
			const conn = postgres(withDatabase(url ?? "", first), {
				max: 1,
				onnotice: () => {},
			});
			try {
				const rows = await conn<{ status: string }[]>`
					select distinct status from export`;
				const statuses = new Set(rows.map((r) => r.status));
				const out = await conn`
					select id from export
					where status_changed_at <= created_at and updated_at > created_at`;
				// An export that changed status after it was created must say when.
				expect(out).toHaveLength(0);
				for (const s of ["previewed", "pr-open", "done", "failed", "closed"]) {
					expect(statuses).toContain(s);
				}
			} finally {
				await conn.end();
			}
		},
		BUDGET_MS,
	);

	it("refuses any database whose name does not end in _dev, before connecting", async () => {
		// Nothing listens on port 1: if the guard connected first, this would
		// fail with a connection error instead of the refusal.
		for (const name of ["avel_test", "avel", "neondb", "avel_dev_backup"]) {
			const target = `postgres://postgres:postgres@127.0.0.1:1/${name}`;
			expect(() => assertDevDatabase(target)).toThrow(/_dev/);
			await expect(runSeed(target)).rejects.toThrow(/_dev/);
		}
	});
});
