import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env on its own. loadEnvFile never overrides a
// variable that is already set, so DATABASE_URL=... pnpm db:migrate still wins.
if (existsSync(".env")) process.loadEnvFile(".env");

// Against Neon, DATABASE_URL here must be the direct (unpooled) connection
// string. The pooled one is for the application only.
export default defineConfig({
	schema: "./src/db/schema/index.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
