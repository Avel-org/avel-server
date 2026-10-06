import { describe, expect, it } from "vitest";
import {
	authConfigFromEnv,
	parseOperatorIds,
	parseWebOrigins,
} from "../../src/auth/config";

const env = {
	BETTER_AUTH_SECRET: "x".repeat(32),
	BETTER_AUTH_URL: "http://localhost:8787",
	GITHUB_CLIENT_ID: "id",
	GITHUB_CLIENT_SECRET: "secret",
	AVEL_OPERATOR_GITHUB_IDS: "123, 456",
};

describe("authConfigFromEnv", () => {
	it("reads every variable and splits the allowlist", () => {
		expect(authConfigFromEnv(env)).toEqual({
			secret: "x".repeat(32),
			baseURL: "http://localhost:8787",
			github: { clientId: "id", clientSecret: "secret" },
			operatorGithubIds: ["123", "456"],
			webOrigins: [],
		});
	});

	it("names every missing variable", () => {
		expect(() =>
			authConfigFromEnv({
				...env,
				GITHUB_CLIENT_ID: "",
				GITHUB_CLIENT_SECRET: undefined,
			}),
		).toThrow(
			"Missing auth environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET",
		);
	});

	it("refuses a secret shorter than 32 characters", () => {
		expect(() =>
			authConfigFromEnv({ ...env, BETTER_AUTH_SECRET: "short" }),
		).toThrow(/at least 32/);
	});
});

describe("parseOperatorIds", () => {
	it("refuses GitHub logins, which can be renamed and reused", () => {
		expect(() => parseOperatorIds("123,octocat")).toThrow(
			/numeric user ids.*octocat/,
		);
	});

	it("refuses an allowlist with no ids in it", () => {
		expect(() => parseOperatorIds(" , ")).toThrow(/empty/);
	});
});

describe("parseWebOrigins", () => {
	it("is empty when unset, meaning same-origin only", () => {
		expect(parseWebOrigins("")).toEqual([]);
	});

	it("accepts exact origins, including the Tauri schemes", () => {
		expect(
			parseWebOrigins(
				"tauri://localhost, http://tauri.localhost, https://app.example.com:8443",
			),
		).toEqual([
			"tauri://localhost",
			"http://tauri.localhost",
			"https://app.example.com:8443",
		]);
	});

	it.each([
		"https://*.example.com",
		"https://app.example.com/",
		"https://app.example.com/path",
		"*",
		"app.example.com",
	])("refuses %s, which is not an exact origin", (raw) => {
		expect(() => parseWebOrigins(raw)).toThrow(/exact origins/);
	});
});
