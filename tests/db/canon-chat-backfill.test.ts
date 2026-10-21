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

// Migration 0042 adds NOT NULL columns to canon_session and canon_message,
// which may already hold rows (avel_dev), and canon_message is append-only,
// so it cannot be backfilled by UPDATE. This replays it: migrate a fresh
// database to 0041, insert a session with messages and one without, then
// apply the rest.
const url = process.env.DATABASE_URL;
const scratch = `avel_canon_backfill_${process.pid}`;
const BUDGET_MS = 60_000;
const BEFORE = "0042_canon_chat";

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

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CLIENT = id(1);
const T0 = "2026-10-19T10:00:00Z";

describe.skipIf(!url)(
	"migration 0042 on a database with Canon sessions",
	() => {
		const admin = url
			? postgres(url, { max: 1, onnotice: () => {} })
			: undefined;
		let partial: string | undefined;

		afterAll(async () => {
			if (partial) rmSync(partial, { recursive: true, force: true });
			await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin?.end();
		}, BUDGET_MS);

		it(
			"fills scope, mode and last activity, and gives every message a mode and no parts",
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

					await conn`insert into "user" (id, name, email, email_verified, github_id, github_login, created_at, updated_at)
					values (${id(9)}, 'Op', 'op@example.test', true, '9', 'op', ${T0}, ${T0})`;
					await conn`insert into client (id, name, status, created_at, updated_at)
					values (${CLIENT}, 'C', 'active', ${T0}, ${T0})`;
					await conn`insert into engagement (id, client_id, name, status, started_at, created_at, updated_at)
					values (${id(2)}, ${CLIENT}, 'E', 'active', ${T0}, ${T0}, ${T0})`;
					await conn`insert into intake (id, engagement_id, status, source_md, open_questions, created_at, updated_at)
					values (${id(3)}, ${id(2)}, 'draft', '# B', '{}', ${T0}, ${T0}),
					(${id(4)}, ${id(2)}, 'draft', '# C', '{}', ${T0}, ${T0})`;
					await conn`insert into agent_template (id, slug, name, kind, roles, wave_defaults, writable_paths, version, created_at, updated_at)
					values (${id(5)}, 'canon', 'Canon', 'horizontal', '{domain}', '{A}', '{}', 1, ${T0}, ${T0})`;
					await conn`insert into agent_identity_version (id, agent_template_id, number, identity_md, depth_md, sha256, identity_tokens, depth_tokens, inputs, created_at)
					values (${id(6)}, ${id(5)}, 1, '# Canon', '', ${"c".repeat(64)}, 1, 0, '{}', ${T0})`;
					const seeds: [string, string][] = [
						[id(10), id(3)],
						[id(11), id(4)],
					];
					for (const [sessionId, intakeId] of seeds) {
						await conn`insert into canon_session (id, intake_id, engagement_id, client_id, status, agent_identity_version_id, model, price_version, harness_version, estimated_tokens, token_soft_ceiling, token_hard_ceiling, tokens_used, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, spend_usd, opened_by, opened_at, created_at, updated_at)
						values (${sessionId}, ${intakeId}, ${id(2)}, ${CLIENT}, 'open', ${id(6)}, 'claude-sonnet-5-5', 'prices-2026-10-14', 'fake', 100, 150, 300, 0, 0, 0, 0, 0, 0, ${id(9)}, ${T0}, ${T0}, ${T0})`;
					}
					await conn`insert into canon_message (id, canon_session_id, client_id, seq, role, content_md, citations, created_at)
					values (${id(20)}, ${id(10)}, ${CLIENT}, 1, 'operator', 'Hi', '[]', '2026-10-19T11:00:00Z'),
					(${id(21)}, ${id(10)}, ${CLIENT}, 2, 'canon', 'Hello', '[]', '2026-10-19T12:00:00Z')`;

					await migrate(drizzle(conn), { migrationsFolder: "drizzle" });

					const sessions = await conn<
						{
							id: string;
							scope: string;
							mode: string;
							last: string;
							key: string;
						}[]
					>`select id, scope, mode, last_activity_at::text as last, scope_key::text as key
					from canon_session order by id`;
					expect(sessions).toEqual([
						{
							id: id(10),
							scope: "client",
							mode: "draft",
							last: "2026-10-19 12:00:00+00",
							key: CLIENT,
						},
						{
							id: id(11),
							scope: "client",
							mode: "draft",
							last: "2026-10-19 10:00:00+00",
							key: CLIENT,
						},
					]);
					const messages = await conn<
						{ mode: string; parts: unknown; key: string }[]
					>`select mode, parts, scope_key::text as key from canon_message order by seq`;
					expect(messages).toEqual([
						{ mode: "draft", parts: [], key: CLIENT },
						{ mode: "draft", parts: [], key: CLIENT },
					]);
					// The defaults were only for the rows already there.
					const defaults = await conn<
						{ column_name: string; d: string | null }[]
					>`
					select column_name, column_default as d from information_schema.columns
					where table_name = 'canon_message' and column_name in ('mode', 'parts')
					order by column_name`;
					expect(defaults).toEqual([
						{ column_name: "mode", d: null },
						{ column_name: "parts", d: null },
					]);
				} finally {
					await conn.end();
				}
			},
			BUDGET_MS,
		);
	},
);
