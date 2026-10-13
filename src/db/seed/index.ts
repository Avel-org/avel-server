import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";
import { withTx } from "../tx";
import { buildSeed, SEED_MARKER_ID, seedIds } from "./data";

export { SEED_EPOCH } from "./data";

export interface SeedResult {
	status: "seeded" | "already-seeded";
	/** Row counts per table after the run, soft-deleted rows included. */
	counts: Record<string, number>;
}

/**
 * Refuses anything that is not a development database. Checked from the URL
 * alone, before any connection opens, so a production or test URL is never
 * touched, not even read.
 */
export function assertDevDatabase(url: string) {
	const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
	if (!/_dev$/.test(name)) {
		throw new Error(
			`db:seed refuses database "${name}": it only runs against a database whose name ends in _dev.`,
		);
	}
}

const COUNTED = [
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
	"role_skills",
] as const;

/**
 * Seeds a development database in one transaction.
 *
 * Idempotent by refusal: if the seed's first client already exists, nothing
 * is written and the result says so. Upserting is not an option, because
 * activity_log is append-only and refuses UPDATE. To start over, drop and
 * re-create the database, then `pnpm db:migrate` and `pnpm db:seed`.
 */
export async function runSeed(url: string): Promise<SeedResult> {
	assertDevDatabase(url);
	const conn = postgres(url, { max: 1, onnotice: () => {} });
	const db = drizzle(conn, { schema });
	try {
		const existing = await db
			.select({ id: schema.client.id })
			.from(schema.client)
			.where(eq(schema.client.id, SEED_MARKER_ID));

		let status: SeedResult["status"] = "already-seeded";
		if (existing.length === 0) {
			const rows = buildSeed(seedIds());
			await withTx(db, async (tx) => {
				await tx.insert(schema.client).values(rows.client);
				await tx.insert(schema.engagement).values(rows.engagement);
				await tx.insert(schema.connection).values(rows.connection);
				await tx.insert(schema.agentTemplate).values(rows.agentTemplate);
				await tx
					.insert(schema.agentIdentityVersion)
					.values(rows.agentIdentityVersion);
				await tx.insert(schema.rosterPreset).values(rows.rosterPreset);
				await tx.insert(schema.playbook).values(rows.playbook);
				await tx.insert(schema.mission).values(rows.mission);
				await tx.insert(schema.rosterEntry).values(rows.rosterEntry);
				await tx.insert(schema.exportTable).values(rows.export);
				await tx.insert(schema.activityLog).values(rows.activityLog);
				await tx.insert(schema.skillSource).values(rows.skillSource);
				await tx.insert(schema.skill).values(rows.skill);
				await tx.insert(schema.roleSkills).values(rows.roleSkills);
			});
			status = "seeded";
		}

		const counts: Record<string, number> = {};
		for (const table of COUNTED) {
			const [row] = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from ${sql.identifier(table)}`,
			);
			counts[table] = Number(row?.n ?? 0);
		}
		return { status, counts };
	} finally {
		await conn.end();
	}
}
