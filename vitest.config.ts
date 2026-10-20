import { defineConfig } from "vitest/config";

// Tests live in tests/, never beside the source they test.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Under the full suite, git and database tests run 3 to 5 s on Windows
		// (measured 2026-10-20), so vitest's 5 s default failed them at random.
		// 20 s still fails a test that hangs.
		testTimeout: 20_000,
		// Migrates DATABASE_URL once before any file runs; a no-op without one.
		globalSetup: ["tests/db/global-setup.ts"],
	},
});
