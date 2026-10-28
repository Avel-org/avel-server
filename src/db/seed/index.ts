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
	"agent_template",
	"agent_identity_version",
	"roster_preset",
	"playbook",
] as const;

/**
 * Seeds a development database in one transaction.
 *
 * Idempotent by refusal: if the seed's first agent template already exists,
 * nothing is written and the result says so. To start over, drop and
 * re-create the database, then `pnpm db:migrate` and `pnpm db:seed`.
 */
export async function runSeed(url: string): Promise<SeedResult> {
	assertDevDatabase(url);
	const conn = postgres(url, { max: 1, onnotice: () => {} });
	const db = drizzle(conn, { schema });
	try {
		const existing = await db
			.select({ id: schema.agentTemplate.id })
			.from(schema.agentTemplate)
			.where(eq(schema.agentTemplate.id, SEED_MARKER_ID));

		let status: SeedResult["status"] = "already-seeded";
		if (existing.length === 0) {
			const rows = buildSeed(seedIds());
			await withTx(db, async (tx) => {
				await tx.insert(schema.agentTemplate).values(rows.agentTemplate);
				await tx
					.insert(schema.agentIdentityVersion)
					.values(rows.agentIdentityVersion);
				await tx.insert(schema.rosterPreset).values(rows.rosterPreset);
				await tx.insert(schema.playbook).values(rows.playbook);
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
