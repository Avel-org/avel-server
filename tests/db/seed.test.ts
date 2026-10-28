import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { assertDevDatabase, runSeed } from "../../src/db/seed";

// The seed runs against throwaway databases whose names end in _dev, because
// it refuses every other name. Creating, migrating and seeding a database is
// server-level work, so these tests carry the same budget as migrate-from-empty.
const url = process.env.DATABASE_URL;
const BUDGET_MS = 60_000;
const first = `avel_seed_a_${process.pid}_dev`;
const second = `avel_seed_b_${process.pid}_dev`;

/** The catalog the seed writes (J, 2026-10-27). */
const CATALOG = [
	"agent_template",
	"agent_identity_version",
	"roster_preset",
	"playbook",
] as const;

/** Tables only real work fills: the seed writes none of them. */
const WORK = [
	"user",
	"account",
	"session",
	"client",
	"engagement",
	"connection",
	"repo_policy",
	"mission",
	"intake",
	"intake_files",
	"file",
	"roster_entry",
	"mission_skills",
	"dispatch",
	"dispatch_step",
	"completion_report",
	"verification",
	"gate_job",
	"finding",
	"export",
	"activity_log",
	"skill_source",
	"skill",
	"role_skills",
	"knowledge_entry",
	"proposal",
	"canon_session",
	"canon_message",
	"canon_question",
	"canon_step",
	"client_memory",
] as const;

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
		for (const table of CATALOG) {
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
			// The operator, fifteen builders and Canon; one identity for each but
			// the operator; the vertical and horizontal presets; one playbook.
			expect(run1.counts).toEqual({
				agent_template: 17,
				agent_identity_version: 16,
				roster_preset: 2,
				playbook: 1,
			});
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
		"writes no work: every table real work fills is empty",
		async () => {
			const conn = postgres(withDatabase(url ?? "", first), {
				max: 1,
				onnotice: () => {},
			});
			try {
				const counts: Record<string, number> = {};
				for (const table of WORK) {
					const [row] = await conn.unsafe<{ n: number }[]>(
						`select count(*)::int as n from "${table}"`,
					);
					counts[table] = row?.n ?? -1;
				}
				expect(counts).toEqual(
					Object.fromEntries(WORK.map((table) => [table, 0])),
				);
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
