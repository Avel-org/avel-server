import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth";
import * as authSchema from "../../src/db/schema/auth";
import { sequentialIds } from "../../src/lib/ids";
import { silentLogger } from "../../src/lib/logger";
import { testAuthConfig } from "./support";

// The Drizzle adapter maps Better Auth's field names onto the table object's
// keys. A missing key fails only at runtime, on the first sign-in, so compare
// them here against the fields Better Auth's own configuration expects.
describe("src/db/schema/auth.ts", () => {
	const auth = createAuth({
		config: testAuthConfig(["1"]),
		database: memoryAdapter({}),
		ids: sequentialIds(),
		logger: silentLogger(),
		recordSignIn: async () => {},
	});
	const expected = getAuthTables(auth.instance.options);
	const tables = {
		user: authSchema.user,
		session: authSchema.session,
		account: authSchema.account,
		verification: authSchema.verification,
	};

	it.each(
		Object.keys(tables) as Array<keyof typeof tables>,
	)("%s has a column for every field Better Auth writes", (model) => {
		const fields = Object.keys(expected[model]?.fields ?? {});
		expect(fields.length).toBeGreaterThan(0);
		const columns = Object.keys(getTableColumns(tables[model]));
		const missing = ["id", ...fields].filter((f) => !columns.includes(f));
		expect(missing).toEqual([]);
	});

	it("extends user with the GitHub identity", () => {
		const fields = Object.keys(expected.user?.fields ?? {});
		expect(fields).toEqual(expect.arrayContaining(["githubId", "githubLogin"]));
	});
});
