import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { createAuth, DISABLED_PATHS, DISABLED_ROUTES } from "../../src/auth";
import { sequentialIds } from "../../src/lib/ids";
import { silentLogger } from "../../src/lib/logger";
import {
	BASE_URL,
	buildApp,
	OPERATOR,
	signInWithGitHub,
	testAuthConfig,
} from "./support";

// Better Auth's disabledPaths matches the request path by exact string, so
// an entry with a route parameter never matched anything. Every entry is
// therefore proven by a real request, for both GET and POST: a still-enabled
// endpoint answers its own method with something other than 404.
/** A concrete request path for an entry: each :param becomes "x". */
const concrete = (entry: string) => entry.replace(/:[^/]+/g, "x");

async function refusedBoth(path: string) {
	const { app } = buildApp();
	const { cookie } = await signInWithGitHub(app, OPERATOR);
	const headers = { cookie: cookie ?? "", origin: BASE_URL };
	const get = await app.request(`/api/auth${path}`, { headers });
	const post = await app.request(`/api/auth${path}`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({}),
	});
	return { get: get.status, post: post.status };
}

describe("every disabled Better Auth endpoint is refused by a real request", () => {
	it("names only real Better Auth endpoints, so a typo cannot pass as refused", () => {
		const { instance } = createAuth({
			config: testAuthConfig(["1"]),
			database: memoryAdapter({}),
			ids: sequentialIds(),
			logger: silentLogger(),
			recordSignIn: async () => {},
		});
		const endpoints = new Set(
			Object.values(instance.api)
				.map((e) => (e as { path?: unknown }).path)
				.filter((p): p is string => typeof p === "string"),
		);
		expect(endpoints.has("/get-session")).toBe(true);
		const unknown = [...DISABLED_PATHS, ...DISABLED_ROUTES].filter(
			(p) => !endpoints.has(p),
		);
		expect(unknown).toEqual([]);
	});

	it("lists only literal paths in DISABLED_PATHS, since parameters never match there", () => {
		expect(DISABLED_PATHS.filter((p) => p.includes(":"))).toEqual([]);
	});

	it.each([
		...DISABLED_PATHS,
		...DISABLED_ROUTES,
	])("%s answers 404 to GET and POST", async (entry) => {
		expect(await refusedBoth(concrete(entry))).toEqual({ get: 404, post: 404 });
	});

	it("refuses GET /api/auth/reset-password/x", async () => {
		expect((await refusedBoth("/reset-password/x")).get).toBe(404);
	});

	it("leaves the endpoints sign-in needs enabled", async () => {
		const { app } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		const res = await app.request("/api/auth/get-session", {
			headers: { cookie: cookie ?? "" },
		});
		expect(res.status).toBe(200);
	});
});
