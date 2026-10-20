import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client";
import { assertRuntimeRole } from "../../src/db/runtime";
import { connectAsApp } from "./app-role";

// The server runs this before it serves (src/index.ts). getDb() here is the
// owner, postgres: exactly what the runtime must never be.
describe.skipIf(!process.env.DATABASE_URL)("assertRuntimeRole", () => {
	afterAll(closeDb);

	it("refuses a superuser", async () => {
		await expect(assertRuntimeRole(getDb())).rejects.toThrow(
			/postgres.*superuser or BYPASSRLS/,
		);
	});

	it("accepts avel_app", async () => {
		const app = connectAsApp();
		try {
			await expect(assertRuntimeRole(app.db)).resolves.toBe("avel_app");
		} finally {
			await app.end();
		}
	});
});
