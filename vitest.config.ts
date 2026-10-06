import { defineConfig } from "vitest/config";

// Tests live in tests/, never beside the source they test.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Migrates DATABASE_URL once before any file runs; a no-op without one.
		globalSetup: ["tests/db/global-setup.ts"],
	},
});
