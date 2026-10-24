import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

// Migration 0053 adds dispatch.wave NOT NULL to a table that holds rows in
// avel_dev. This replays that: migrate a fresh database to 0052, insert
// queued dispatches on three roster entries, then apply the rest.
const url = process.env.DATABASE_URL;
const scratch = `avel_wave_backfill_${process.pid}`;
const BUDGET_MS = 60_000;
const BEFORE = "0053_dispatch_wave";

function withDatabase(base: string, name: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	return u.toString();
}

/** A copy of drizzle/ whose journal stops just before `tag`. */
function migrationsBefore(tag: string) {
	const dir = mkdtempSync(join(tmpdir(), "avel-mig-"));
	cpSync("drizzle", dir, { recursive: true });
	const path = join(dir, "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(path, "utf-8")) as {
		entries: { tag: string }[];
	};
	const cut = journal.entries.findIndex((e) => e.tag === tag);
	if (cut < 0) throw new Error(`no migration tagged ${tag}`);
	journal.entries = journal.entries.slice(0, cut);
	writeFileSync(path, JSON.stringify(journal));
	return dir;
}

describe.skipIf(!url)("migration 0053 on a database with dispatches", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
	let partial: string | undefined;

	afterAll(async () => {
		if (partial) rmSync(partial, { recursive: true, force: true });
		await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
		await admin?.end();
	}, BUDGET_MS);

	it(
		"backfills each dispatch's wave from its entry's earliest wave, A for an entry in none, then makes it NOT NULL",
		async () => {
			if (!url || !admin) return;
			await admin.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin.unsafe(`create database ${scratch}`);
			const conn = postgres(withDatabase(url, scratch), {
				max: 1,
				onnotice: () => {},
			});
			try {
				partial = migrationsBefore(BEFORE);
				await migrate(drizzle(conn), { migrationsFolder: partial });

				const at = "2026-09-01T00:00:00Z";
				const mission = "00000000-0000-4000-8000-000000000001";
				const template = "00000000-0000-4000-8000-000000000002";
				await conn`insert into mission (id, engagement_id, origin, type, brief, sprint_n, status, cut, cut_source, repo_url, created_at, updated_at)
					values (${mission}, null, 'internal', 'full-build', '{}', 1, 'active', 'vertical', 'derived', 'https://github.com/x/y', ${at}, ${at})`;
				await conn`insert into agent_template (id, slug, name, kind, roles, wave_defaults, writable_paths, version, created_at, updated_at)
					values (${template}, 'kel', 'Kel', 'horizontal', '{domain}', '{B}', '{src/**}', 1, ${at}, ${at})`;
				// Listed C before B: the earliest is by wave order, not list order.
				const entries = [
					["00000000-0000-4000-8000-000000000011", "{C,B}"],
					["00000000-0000-4000-8000-000000000012", "{D}"],
					["00000000-0000-4000-8000-000000000013", "{}"],
				] as const;
				for (const [i, [entry, waves]] of entries.entries()) {
					await conn`insert into roster_entry (id, mission_id, agent_template_id, active, waves, grain, absorbed_boundaries, created_at, updated_at)
						values (${entry}, ${mission}, ${template}, true, ${waves}::wave[], 'default', '{}', ${at}, ${at})`;
					await conn`insert into dispatch (id, roster_entry_id, mission_id, status, estimated_tokens, token_soft_ceiling, token_hard_ceiling, tokens_used, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, soft_ceiling_crossed, spend_usd, wall_clock_minutes, idempotency_key, request_sha256, created_at, updated_at)
						values (${`00000000-0000-4000-8000-00000000002${i}`}, ${entry}, ${mission}, 'queued', 1000, 1500, 3000, 0, 0, 0, 0, 0, false, 0, 60, ${`k${i}`}, ${"5".repeat(64)}, ${at}, ${at})`;
				}

				await migrate(drizzle(conn), { migrationsFolder: "drizzle" });

				const rows = await conn<{ wave: string }[]>`
					select wave from dispatch order by id`;
				expect(rows.map((r) => r.wave)).toEqual(["B", "D", "A"]);
				const [col] = await conn<{ is_nullable: string }[]>`
					select is_nullable from information_schema.columns
					where table_name = 'dispatch' and column_name = 'wave'`;
				expect(col?.is_nullable).toBe("NO");
			} finally {
				await conn.end();
			}
		},
		BUDGET_MS,
	);
});
