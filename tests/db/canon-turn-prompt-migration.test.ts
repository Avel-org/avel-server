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

// Migration 0045 adds canon_session's turn claim (turn_prompt_seq and
// turn_prompt_sha256) to a table that already holds rows. Both are
// nullable: no earlier turn has a stored claim, and null reads as "not yet
// run", so a session left mid-turn by the old code runs once. This replays
// it: migrate a fresh database to 0044, insert sessions, then apply 0045.
const url = process.env.DATABASE_URL;
const scratch = `avel_turn_prompt_${process.pid}`;
const BUDGET_MS = 60_000;
const BEFORE = "0045_canon_turn_prompt";

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
const T0 = "2026-10-21T10:00:00Z";

describe.skipIf(!url)(
	"migration 0045 on a database with Canon sessions",
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
			"adds the turn claim as null on every session, a mid-turn one included, and holds its shape",
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
					// id(10) is mid-turn, as the old code would leave it; id(11) is idle.
					for (const [sessionId, intakeId, turn] of [
						[id(10), id(3), T0],
						[id(11), id(4), null],
					] as const) {
						await conn`insert into canon_session (id, intake_id, engagement_id, client_id, scope, mode, status, agent_identity_version_id, model, price_version, harness_version, estimated_tokens, token_soft_ceiling, token_hard_ceiling, tokens_used, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, spend_usd, opened_by, opened_at, last_activity_at, turn_started_at, created_at, updated_at)
						values (${sessionId}, ${intakeId}, ${id(2)}, ${CLIENT}, 'client', 'draft', 'open', ${id(6)}, 'claude-sonnet-5-5', 'prices-2026-10-14', 'fake', 100, 150, 300, 0, 0, 0, 0, 0, 0, ${id(9)}, ${T0}, ${T0}, ${turn}, ${T0}, ${T0})`;
					}
					await conn`insert into canon_message (id, canon_session_id, client_id, seq, role, mode, content_md, citations, parts, created_at)
					values (${id(20)}, ${id(10)}, ${CLIENT}, 1, 'operator', 'draft', 'Hi', '[]', '[]', ${T0})`;

					await migrate(drizzle(conn), { migrationsFolder: "drizzle" });

					expect(
						await conn<
							{ id: string; seq: number | null; sha: string | null }[]
						>`select id, turn_prompt_seq as seq, turn_prompt_sha256 as sha
						from canon_session order by id`,
					).toEqual([
						{ id: id(10), seq: null, sha: null },
						{ id: id(11), seq: null, sha: null },
					]);
					// Null is "not yet run", so the mid-turn session is not a repeat.
					const [repeat] = await conn<{ claimed: boolean }[]>`
					select coalesce("canon_session"."turn_prompt_seq" = (
						select max("m"."seq") from "canon_message" "m"
						where "m"."canon_session_id" = "canon_session"."id" and "m"."role" = 'operator'
					), false) as claimed
					from canon_session where id = ${id(10)}`;
					expect(repeat?.claimed).toBe(false);

					// The claim's shape: both or neither, a positive seq, a hex hash.
					const sha = "a".repeat(64);
					for (const [seq, hash, constraint] of [
						[1, null, "canon_session_turn_prompt_complete"],
						[null, sha, "canon_session_turn_prompt_complete"],
						[0, sha, "canon_session_turn_prompt_seq_positive"],
						[1, "A".repeat(64), "canon_session_turn_prompt_sha256_hex"],
					] as const) {
						await expect(
							conn`update canon_session set turn_prompt_seq = ${seq}, turn_prompt_sha256 = ${hash} where id = ${id(10)}`,
						).rejects.toMatchObject({ constraint_name: constraint });
					}
					await conn`update canon_session set turn_prompt_seq = 1, turn_prompt_sha256 = ${sha} where id = ${id(10)}`;
				} finally {
					await conn.end();
				}
			},
			BUDGET_MS,
		);
	},
);
