import { describe, expect, it } from "vitest";
import { runtimeDatabaseUrl } from "../../src/db/runtime";

const OWNER = "postgres://postgres:postgres@localhost:5432/avel_dev";
const APP = "postgres://avel_app:avel_app@localhost:5432/avel_dev";

describe("runtimeDatabaseUrl", () => {
	it("is AVEL_APP_DATABASE_URL", () => {
		expect(
			runtimeDatabaseUrl({ DATABASE_URL: OWNER, AVEL_APP_DATABASE_URL: APP }),
		).toBe(APP);
	});

	it("refuses to start without it, in dev and in production alike", () => {
		for (const NODE_ENV of [undefined, "development", "production"]) {
			expect(() =>
				runtimeDatabaseUrl({ NODE_ENV, DATABASE_URL: OWNER }),
			).toThrow(/AVEL_APP_DATABASE_URL is not set/);
			expect(() =>
				runtimeDatabaseUrl({
					NODE_ENV,
					DATABASE_URL: OWNER,
					AVEL_APP_DATABASE_URL: "",
				}),
			).toThrow(/AVEL_APP_DATABASE_URL is not set/);
		}
	});

	it("refuses the owner's login as the runtime's", () => {
		expect(() =>
			runtimeDatabaseUrl({ DATABASE_URL: OWNER, AVEL_APP_DATABASE_URL: OWNER }),
		).toThrow(/same role as DATABASE_URL/);
	});

	it("refuses a runtime database other than the one DATABASE_URL migrates", () => {
		expect(() =>
			runtimeDatabaseUrl({
				DATABASE_URL: OWNER,
				AVEL_APP_DATABASE_URL: APP.replace("avel_dev", "avel_test"),
			}),
		).toThrow(/avel_test.*avel_dev/);
	});

	it("allows another host for the same database: Neon's pooled and direct endpoints differ", () => {
		const pooled =
			"postgres://avel_app:x@ep-calm-1-pooler.us-east-2.aws.neon.tech/neondb";
		expect(
			runtimeDatabaseUrl({
				DATABASE_URL:
					"postgres://neondb_owner:y@ep-calm-1.us-east-2.aws.neon.tech/neondb",
				AVEL_APP_DATABASE_URL: pooled,
			}),
		).toBe(pooled);
	});

	it("needs no DATABASE_URL beside it", () => {
		expect(runtimeDatabaseUrl({ AVEL_APP_DATABASE_URL: APP })).toBe(APP);
	});
});
