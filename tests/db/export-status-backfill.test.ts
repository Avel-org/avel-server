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

// Migration 0012 adds export.status_changed_at NOT NULL to a table that may
// already hold rows (avel_dev, and Neon later). This replays that: migrate a
// fresh database to 0011, insert exports, then apply the rest.
const url = process.env.DATABASE_URL;
const scratch = `avel_backfill_${process.pid}`;
const BUDGET_MS = 60_000;
const BEFORE = "0012_export_status_changed_at";

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

describe.skipIf(!url)("migration 0012 on a database with exports", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
	let partial: string | undefined;

	afterAll(async () => {
		if (partial) rmSync(partial, { recursive: true, force: true });
		await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
		await admin?.end();
	}, BUDGET_MS);

	it(
		"backfills status_changed_at from created_at, then makes it NOT NULL",
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

				await conn`insert into client (id, name, status, created_at, updated_at)
					values ('00000000-0000-4000-8000-000000000001', 'C', 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
				await conn`insert into mission (id, engagement_id, origin, type, brief, sprint_n, status, cut, cut_source, repo_url, created_at, updated_at)
					values ('00000000-0000-4000-8000-000000000002', null, 'internal', 'full-build', '{}', 1, 'active', 'vertical', 'derived', 'https://github.com/x/y', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
				// The done export is rendered, or migration 0056 refuses it.
				await conn`insert into export (id, mission_id, sprint_n, idempotency_key, target_kind, status, version_manifest, package_sha256, package_hash_version, created_at, updated_at)
					values
					('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 1, 'k1', 'zip', 'done', '{}', ${"a".repeat(64)}, 1, '2026-09-02T00:00:00Z', '2026-09-05T00:00:00Z'),
					('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', 1, 'k2', 'zip', 'failed', null, null, null, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')`;

				await migrate(drizzle(conn), { migrationsFolder: "drizzle" });

				const rows = await conn<{ same: boolean }[]>`
					select status_changed_at = created_at as same from export order by id`;
				expect(rows.map((r) => r.same)).toEqual([true, true]);
				const [col] = await conn<{ is_nullable: string }[]>`
					select is_nullable from information_schema.columns
					where table_name = 'export' and column_name = 'status_changed_at'`;
				expect(col?.is_nullable).toBe("NO");
			} finally {
				await conn.end();
			}
		},
		BUDGET_MS,
	);
});
