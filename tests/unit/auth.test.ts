import { describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import {
	BASE_URL,
	buildApp,
	OPERATOR,
	STRANGER,
	signInWithGitHub,
} from "./support";

describe("operator sign-in with GitHub", () => {
	it("signs an allowlisted operator in, with ids from the injected generator", async () => {
		const { app, memory } = buildApp();
		const result = await signInWithGitHub(app, OPERATOR);
		expect(result.status).toBe(302);
		expect(result.cookie).not.toBeNull();
		expect(memory.user).toHaveLength(1);
		expect(memory.user?.[0]).toMatchObject({
			githubId: "1001",
			githubLogin: "operator",
			email: "operator@example.com",
		});
		expect(memory.user?.[0]?.id).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
		expect(memory.session).toHaveLength(1);
	});

	it("refuses a GitHub account that is not on the allowlist, creating nothing", async () => {
		const { app, memory, logs } = buildApp();
		const result = await signInWithGitHub(app, STRANGER);
		expect(result.cookie).toBeNull();
		expect(result.location).toContain("error=");
		expect(memory.user).toHaveLength(0);
		expect(memory.session).toHaveLength(0);
		expect(
			logs.some((l) => String(l.msg).includes("not on the operator allowlist")),
		).toBe(true);
	});

	it("refuses a new session for an existing user who was removed from the allowlist", async () => {
		const { app, memory } = buildApp();
		await signInWithGitHub(app, OPERATOR);
		// Same stored user, a fresh server whose allowlist no longer holds them.
		const later = buildApp({ operators: ["9999"] });
		later.memory.user = memory.user ?? [];
		later.memory.account = memory.account ?? [];
		const result = await signInWithGitHub(later.app, OPERATOR);
		expect(result.cookie).toBeNull();
		expect(later.memory.session).toHaveLength(0);
	});
});

describe("auth.signed_in", () => {
	it("is recorded once per sign-in, with the user and the callback's request id", async () => {
		const { app, memory, signIns } = buildApp();
		await signInWithGitHub(app, OPERATOR);
		expect(signIns).toEqual([
			{
				userId: memory.user?.[0]?.id,
				// Request 1 starts sign-in; request 2 is the callback that creates the session.
				requestId: "00000000-0000-4000-8000-000000000002",
			},
		]);
	});

	it("is not recorded for a refused GitHub account", async () => {
		const { app, signIns } = buildApp();
		await signInWithGitHub(app, STRANGER);
		expect(signIns).toEqual([]);
	});

	it("fails closed: when the log row cannot be written, sign-in fails and no session exists", async () => {
		const { app, memory } = buildApp({
			recordSignIn: async () => {
				throw new Error("activity_log is down");
			},
		});
		const result = await signInWithGitHub(app, OPERATOR);
		expect(result.cookie).toBeNull();
		expect(memory.session).toHaveLength(0);
	});

	it("ignores a client-sent request id header", async () => {
		const { app, signIns } = buildApp();
		await signInWithGitHub(app, OPERATOR, { "x-avel-request-id": "forged" });
		expect(signIns[0]?.requestId).not.toBe("forged");
	});
});

describe("Better Auth surface", () => {
	it("stores the GitHub token encrypted, never as sent", async () => {
		const { app, memory } = buildApp();
		await signInWithGitHub(app, OPERATOR);
		const stored = memory.account?.[0]?.accessToken;
		expect(typeof stored).toBe("string");
		expect(stored).not.toContain("gho_test_token");
	});

	it.each([
		"/api/auth/update-user",
		"/api/auth/get-access-token",
		"/api/auth/sign-up/email",
	])("keeps %s disabled, even for a signed-in operator", async (path) => {
		const { app } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		const res = await app.request(path, {
			method: "POST",
			headers: {
				cookie: cookie ?? "",
				"content-type": "application/json",
				origin: BASE_URL,
			},
			body: JSON.stringify({ githubId: "9999", providerId: "github" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("auth middleware", () => {
	it("refuses a request without a session with 401 UNAUTHENTICATED", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/nothing-here");
		expect(res.status).toBe(401);
		const body = errorEnvelope.parse(await res.json());
		expect(body.error.code).toBe("UNAUTHENTICATED");
		expect(body.error.requestId).toBe("00000000-0000-4000-8000-000000000001");
	});

	it("refuses a forged session cookie with 401", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/nothing-here", {
			headers: { cookie: "better-auth.session_token=forged.value" },
		});
		expect(res.status).toBe(401);
	});

	it("lets an operator's session through to the router", async () => {
		const { app } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		const res = await app.request("/api/nothing-here", {
			headers: { cookie: cookie ?? "" },
		});
		// Past auth, the router answers: this route does not exist.
		expect(res.status).toBe(404);
		expect(errorEnvelope.parse(await res.json()).error.code).toBe("NOT_FOUND");
	});

	it("locks out a live session once its GitHub id leaves the allowlist", async () => {
		const first = buildApp();
		const { cookie } = await signInWithGitHub(first.app, OPERATOR);
		const later = buildApp({ operators: ["9999"] });
		later.memory.user = first.memory.user ?? [];
		later.memory.session = first.memory.session ?? [];
		const res = await later.app.request("/api/nothing-here", {
			headers: { cookie: cookie ?? "" },
		});
		expect(res.status).toBe(403);
		expect(errorEnvelope.parse(await res.json()).error.code).toBe(
			"NOT_OPERATOR",
		);
	});

	it("leaves /api/health public", async () => {
		const { app } = buildApp();
		expect((await app.request("/api/health")).status).toBe(200);
	});

	it("does not treat a path that merely starts with /api/auth as public", async () => {
		const { app } = buildApp();
		expect((await app.request("/api/authx")).status).toBe(401);
	});
});
