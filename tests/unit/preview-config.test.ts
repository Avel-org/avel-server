import { describe, expect, it } from "vitest";
import {
	previewAuthConfig,
	previewConfigFromEnv,
} from "../../src/auth/preview";
import { sequentialIds } from "../../src/lib/ids";

const local = {
	AVEL_DEV_PREVIEW: "1",
	NODE_ENV: "development",
	DATABASE_URL: "postgres://postgres:postgres@localhost:5432/avel_dev",
	BETTER_AUTH_URL: "http://localhost:3000",
};

describe("previewConfigFromEnv", () => {
	it.each([
		undefined,
		"",
		"0",
		"true",
		"yes",
		" 1",
	])("is off unless AVEL_DEV_PREVIEW is exactly 1 (%s)", (value) => {
		expect(previewConfigFromEnv({ ...local, AVEL_DEV_PREVIEW: value })).toEqual(
			{
				enabled: false,
			},
		);
	});

	it("is on when asked, naming every guard that passed", () => {
		expect(previewConfigFromEnv(local)).toEqual({
			enabled: true,
			guards: [
				"NODE_ENV is not production (development)",
				"database avel_dev ends in _dev",
				"BETTER_AUTH_URL host localhost is local",
			],
		});
		expect(
			previewConfigFromEnv({
				...local,
				NODE_ENV: undefined,
				BETTER_AUTH_URL: "http://127.0.0.1:3000",
			}).enabled,
		).toBe(true);
	});

	it("refuses to start in production", () => {
		expect(() =>
			previewConfigFromEnv({ ...local, NODE_ENV: "production" }),
		).toThrow(/AVEL_DEV_PREVIEW refuses.*production/);
	});

	it.each([
		"avel_test",
		"avel_dev_backup",
		"neondb",
	])("refuses database %s", (name) => {
		expect(() =>
			previewConfigFromEnv({
				...local,
				DATABASE_URL: `postgres://u:p@localhost:5432/${name}`,
			}),
		).toThrow(/AVEL_DEV_PREVIEW refuses.*_dev/);
	});

	it("refuses a missing DATABASE_URL", () => {
		expect(() =>
			previewConfigFromEnv({ ...local, DATABASE_URL: undefined }),
		).toThrow(/AVEL_DEV_PREVIEW refuses.*DATABASE_URL/);
	});

	it.each([
		"https://avel.example.com",
		"http://localhost.evil.com:3000",
		"http://10.0.0.5:3000",
		"not a url",
	])("refuses BETTER_AUTH_URL %s", (url) => {
		expect(() =>
			previewConfigFromEnv({ ...local, BETTER_AUTH_URL: url }),
		).toThrow(/AVEL_DEV_PREVIEW refuses.*BETTER_AUTH_URL/);
	});
});

describe("previewAuthConfig: preview starts without GitHub credentials", () => {
	const ids = sequentialIds();
	const real = {
		...local,
		BETTER_AUTH_SECRET: "x".repeat(32),
		GITHUB_CLIENT_ID: "id",
		GITHUB_CLIENT_SECRET: "secret",
		AVEL_OPERATOR_GITHUB_IDS: "123",
	};

	it("uses the real config, sign-in on, when every auth variable is set", () => {
		const { config, missing } = previewAuthConfig(real, ids);
		expect(missing).toEqual([]);
		expect(config.signInDisabled).toBeUndefined();
		expect(config.operatorGithubIds).toEqual(["123"]);
	});

	it("disables sign-in, with nobody allowed and a one-off secret, when auth variables are missing", () => {
		const { config, missing } = previewAuthConfig(local, ids);
		expect(missing).toEqual([
			"BETTER_AUTH_SECRET",
			"GITHUB_CLIENT_ID",
			"GITHUB_CLIENT_SECRET",
			"AVEL_OPERATOR_GITHUB_IDS",
		]);
		expect(config.signInDisabled).toBe(true);
		expect(config.operatorGithubIds).toEqual([]);
		expect(config.secret.length).toBeGreaterThanOrEqual(32);
		expect(config.baseURL).toBe("http://localhost:3000");
		expect(previewAuthConfig(local, ids).config.secret).not.toBe(config.secret);
	});

	it("still refuses malformed values that are present", () => {
		expect(() =>
			previewAuthConfig({ ...real, AVEL_OPERATOR_GITHUB_IDS: "octocat" }, ids),
		).toThrow(/numeric/);
	});
});
