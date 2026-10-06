import { existsSync } from "node:fs";
import { runSeed } from "./index";

// `pnpm db:seed`: seeds the database in DATABASE_URL (from .env when present),
// which must be a development database. See runSeed for the rules.
if (existsSync(".env")) process.loadEnvFile(".env");

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("DATABASE_URL is not set. Copy .env.example to .env.");
	process.exit(1);
}

try {
	const { status, counts } = await runSeed(url);
	console.log(
		status === "seeded"
			? "Seeded."
			: "Already seeded; nothing written. To start over, re-create the database, then pnpm db:migrate and pnpm db:seed.",
	);
	for (const [table, n] of Object.entries(counts)) {
		console.log(`  ${table.padEnd(16)} ${n}`);
	}
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
}
