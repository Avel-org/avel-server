import { randomUUID } from "node:crypto";
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
import * as schema from "../../src/db/schema";
import { canonSession, clientMemory, mission } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { seedTenants } from "./app-role";
import { seedCanonIdentity, sessionValues } from "./canon-fixtures";
import { clock } from "./fixtures";

// Migration 0047 adds activity_log.client_id and backfills every older row.
// Two traps it must get past, both invisible to a superuser:
// - client_memory, canon_session and canon_question FORCE row-level
//   security, so an owner that is not a superuser (Neon's) reads none of
//   their rows unless the migration lifts FORCE for the backfill;
// - activity_log refuses UPDATE by trigger, so the migration disables it
//   for the backfill, and must turn it back on.
// So this replays it on a database migrated to 0046 with rows in it, then
// applies 0047 as a non-superuser that owns every table, as on Neon.

const url = process.env.DATABASE_URL;
const scratch = `avel_client_backfill_${process.pid}`;
const owner = `avel_owner_${process.pid}`;
const BUDGET_MS = 90_000;
const BEFORE = "0047_activity_client_id";
const FORCED = ["client_memory", "canon_session", "canon_question"];

function withDatabase(base: string, name: string, login?: string) {
	const u = new URL(base);
	u.pathname = `/${name}`;
	if (login) {
		u.username = login;
		u.password = login;
	}
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

describe.skipIf(!url)("migration 0047 on a database with activity", () => {
	const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
	let partial: string | undefined;

	afterAll(async () => {
		if (partial) rmSync(partial, { recursive: true, force: true });
		await admin?.unsafe(`drop database if exists ${scratch} with (force)`);
		await admin?.unsafe(`drop role if exists ${owner}`);
		await admin?.end();
	}, BUDGET_MS);

	it(
		"backfills client_id as a non-superuser owner, then puts back the trigger and FORCE",
		async () => {
			if (!url || !admin) return;
			await admin.unsafe(`drop database if exists ${scratch} with (force)`);
			await admin.unsafe(`drop role if exists ${owner}`);
			await admin.unsafe(`create database ${scratch}`);
			await admin.unsafe(
				`create role ${owner} login password '${owner}' nosuperuser nobypassrls nocreaterole nocreatedb`,
			);
			const su = postgres(withDatabase(url, scratch), {
				max: 1,
				onnotice: () => {},
			});
			const asOwner = postgres(withDatabase(url, scratch, owner), {
				max: 1,
				onnotice: () => {},
			});
			try {
				partial = migrationsBefore(BEFORE);
				await migrate(drizzle(su), { migrationsFolder: partial });

				// Rows as the superuser, which row-level security lets through.
				const db = drizzle(su, { schema });
				const tx = db as unknown as Parameters<typeof seedTenants>[0];
				const { userId, a, b } = await seedTenants(tx, ["Meridian", "Halcyon"]);
				const versionId = await seedCanonIdentity(tx);
				const missionId = randomUUID();
				await db.insert(mission).values({
					id: missionId,
					origin: "client",
					engagementId: a.engagementId,
					type: "full-build",
					brief: {},
					sprintN: 1,
					status: "draft",
					cut: "vertical",
					cutSource: "derived",
					repoUrl: "https://github.com/meridian-co/app",
					...stamp(clock),
				});
				const memoryId = randomUUID();
				await db.insert(clientMemory).values({
					id: memoryId,
					clientId: b.clientId,
					contentMd: "Prefers Tuesday calls",
					status: "kept",
					...stamp(clock),
				});
				const bare = sessionValues(a, userId, versionId, {
					intakeId: null,
					engagementId: null,
					mode: "ask",
				});
				const open = sessionValues(a, userId, versionId, {
					scope: "open",
					clientId: null,
					intakeId: null,
					engagementId: null,
					mode: "ask",
				});
				await db.insert(canonSession).values([bare, open]);
				const skillSourceId = randomUUID();

				// One row per way a row reaches its client, and one on none.
				const rows: Array<
					[string, string, string, string | null, string | null]
				> = [
					["client.created", "client", a.clientId, null, null],
					[
						"engagement.created",
						"engagement",
						a.engagementId,
						a.engagementId,
						null,
					],
					["mission.status_changed", "mission", missionId, null, missionId],
					["client_memory.kept", "client_memory", memoryId, null, null],
					[
						"canon_session.opened",
						"canon_session",
						bare.id as string,
						null,
						null,
					],
					[
						"canon_session.opened",
						"canon_session",
						open.id as string,
						null,
						null,
					],
					["skill_source.created", "skill_source", skillSourceId, null, null],
				];
				const ids: string[] = [];
				for (const [action, entityType, entityId, engagementId, mId] of rows) {
					const id = randomUUID();
					ids.push(id);
					await su`insert into activity_log
						(id, at, actor_kind, action, entity_type, entity_id, engagement_id, mission_id, request_id, payload)
						values (${id}, now(), 'system', ${action}, ${entityType}, ${entityId}, ${engagementId}, ${mId}, 'test', '{}')`;
				}

				// What the old predicate (touchesClient before 0047: the client
				// entity, its engagements, their missions) found for each client,
				// on the data before the migration.
				const oldMatches = async (clientId: string) =>
					(
						await su<{ id: string }[]>`
						select id from activity_log
						where id = any(${ids}) and (
							(entity_type = 'client' and entity_id = ${clientId})
							or engagement_id in (select id from engagement where client_id = ${clientId})
							or mission_id in (
								select m.id from mission m join engagement e on e.id = m.engagement_id
								where e.client_id = ${clientId}
							)
						)`
					)
						.map((r) => r.id)
						.sort();
				const before = {
					a: await oldMatches(a.clientId),
					b: await oldMatches(b.clientId),
				};
				expect(before.a).toEqual([ids[0], ids[1], ids[2]].sort());
				expect(before.b).toEqual([]);

				// Neon's shape: a non-superuser owns every table, type and
				// function the migrations made.
				await su.unsafe(`
					alter database ${scratch} owner to ${owner};
					alter schema public owner to ${owner};
					alter schema drizzle owner to ${owner};
					do $$ declare r record; begin
						for r in select schemaname, tablename from pg_tables where schemaname in ('public', 'drizzle') loop
							execute format('alter table %I.%I owner to ${owner}', r.schemaname, r.tablename);
						end loop;
						for r in select n.nspname, t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
							where n.nspname = 'public' and t.typtype = 'e' loop
							execute format('alter type %I.%I owner to ${owner}', r.nspname, r.typname);
						end loop;
						for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
							where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
							execute format('alter function %s owner to ${owner}', r.f);
						end loop;
					end $$;`);
				const [who] = await asOwner<{ su: boolean; bypass: boolean }[]>`
					select rolsuper as su, rolbypassrls as bypass from pg_roles where rolname = current_user`;
				expect(who).toEqual({ su: false, bypass: false });

				await migrate(drizzle(asOwner), { migrationsFolder: "drizzle" });

				const after = await su<{ id: string; client_id: string | null }[]>`
					select id, client_id from activity_log where id = any(${ids})`;
				const byId = new Map(after.map((r) => [r.id, r.client_id]));
				expect(ids.map((id) => byId.get(id))).toEqual([
					a.clientId,
					a.clientId,
					a.clientId,
					b.clientId,
					a.clientId,
					null,
					null,
				]);

				// The new predicate, client_id = X, finds every row the old one did,
				// and adds only the rows it missed: a client's memory and a Canon
				// session on the client alone.
				const newMatches = async (clientId: string) =>
					(
						await su<{ id: string }[]>`
						select id from activity_log where id = any(${ids}) and client_id = ${clientId}`
					)
						.map((r) => r.id)
						.sort();
				expect(await newMatches(a.clientId)).toEqual(
					[...before.a, ids[4]].sort(),
				);
				expect(await newMatches(b.clientId)).toEqual(
					[...before.b, ids[3]].sort(),
				);

				// The trigger is back: no UPDATE, DELETE or TRUNCATE.
				for (const statement of [
					`update activity_log set request_id = 'x' where id = '${ids[0]}'`,
					`delete from activity_log where id = '${ids[0]}'`,
					"truncate activity_log",
				]) {
					await expect(asOwner.unsafe(statement), statement).rejects.toThrow(
						/append-only/,
					);
				}
				const [trigger] = await su<{ enabled: string }[]>`
					select tgenabled as enabled from pg_trigger
					where tgname = 'activity_log_no_update_delete'`;
				expect(trigger?.enabled).toBe("O");
				// And FORCE is back on each table it was lifted from.
				const forced = await su<{ name: string; force: boolean }[]>`
					select relname as name, relforcerowsecurity as force from pg_class
					where relname = any(${FORCED}) order by relname`;
				expect(forced).toEqual(
					[...FORCED].sort().map((name) => ({ name, force: true })),
				);
			} finally {
				await asOwner.end();
				await su.end();
			}
		},
		BUDGET_MS,
	);
});
