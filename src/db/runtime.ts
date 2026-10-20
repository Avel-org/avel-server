import { sql } from "drizzle-orm";
import type { Executor } from "./tx";

/**
 * The connection string the server runs on: AVEL_APP_DATABASE_URL, the
 * avel_app role. DATABASE_URL stays the owner's, for migrations, the seed and
 * the test harness.
 *
 * Unset refuses everywhere, dev included. The only fallback is DATABASE_URL,
 * which is the superuser locally, and assertRuntimeRole refuses that anyway.
 * A fallback that skipped the check would run with row-level security off and
 * nothing saying so.
 */
export function runtimeDatabaseUrl(
	env: Record<string, string | undefined>,
): string {
	const app = env.AVEL_APP_DATABASE_URL;
	if (!app) {
		throw new Error(
			"AVEL_APP_DATABASE_URL is not set. The server connects as avel_app, never the owner; see .env.example.",
		);
	}
	const owner = env.DATABASE_URL;
	if (owner) {
		const a = new URL(app);
		const o = new URL(owner);
		if (a.username === o.username) {
			throw new Error(
				`AVEL_APP_DATABASE_URL logs in as ${a.username}, the same role as DATABASE_URL. The runtime role must not be the owner.`,
			);
		}
		// Hosts may differ (Neon's pooled endpoint is not the direct one); the
		// database may not, or the dev preview's _dev guard checks the wrong one.
		if (a.pathname !== o.pathname) {
			throw new Error(
				`AVEL_APP_DATABASE_URL names ${a.pathname.slice(1)}, but DATABASE_URL names ${o.pathname.slice(1)}.`,
			);
		}
	}
	return app;
}

/**
 * Refuses a runtime role that row-level security would not hold: a superuser,
 * a BYPASSRLS role, a member of either, or a member of the owner of any table
 * under row-level security (an owner can switch it off). Returns the role.
 */
export async function assertRuntimeRole(db: Executor): Promise<string> {
	const [row] = await db.execute<{
		role: string;
		bypass: boolean;
		owns: boolean;
	}>(sql`
		select
			current_user as role,
			exists (
				select 1 from pg_roles r
				where (r.rolsuper or r.rolbypassrls)
					and pg_has_role(current_user, r.oid, 'MEMBER')
			) as bypass,
			exists (
				select 1 from pg_class c
				where c.relrowsecurity
					and pg_has_role(current_user, c.relowner, 'MEMBER')
			) as owns`);
	if (!row)
		throw new Error("assertRuntimeRole: the role query returned no row");
	if (row.bypass) {
		throw new Error(
			`The runtime role ${row.role} is a superuser or BYPASSRLS, or a member of one. Row-level security would not apply. Point AVEL_APP_DATABASE_URL at avel_app.`,
		);
	}
	if (row.owns) {
		throw new Error(
			`The runtime role ${row.role} owns a table under row-level security and could switch it off. Point AVEL_APP_DATABASE_URL at avel_app.`,
		);
	}
	return row.role;
}
