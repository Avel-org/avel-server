import { describe, expect, it } from "vitest";
import { BASE_URL, buildApp, TAURI_ORIGIN } from "./support";

const EVIL = "https://evil.example.com";

function startSignIn(
	app: ReturnType<typeof buildApp>["app"],
	headers: Record<string, string>,
) {
	return app.request("/api/auth/sign-in/social", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ provider: "github", callbackURL: "/" }),
	});
}

describe("BETTER_AUTH_URL is the app origin, behind the app's proxy", () => {
	it("builds the GitHub redirect_uri from BETTER_AUTH_URL, not the proxied Host", async () => {
		const { app } = buildApp();
		const res = await startSignIn(app, {
			origin: BASE_URL,
			host: "internal-api:8787",
			"x-forwarded-host": "evil.example.com",
		});
		expect(res.status).toBe(200);
		const { url } = (await res.json()) as { url: string };
		expect(new URL(url).searchParams.get("redirect_uri")).toBe(
			`${BASE_URL}/api/auth/callback/github`,
		);
	});
});

describe("credentialed CORS for AVEL_WEB_ORIGINS", () => {
	it("answers a listed origin's preflight with its origin and credentials", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/clients", {
			method: "OPTIONS",
			headers: {
				origin: TAURI_ORIGIN,
				"access-control-request-method": "POST",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(TAURI_ORIGIN);
		expect(res.headers.get("access-control-allow-credentials")).toBe("true");
	});

	it("echoes a listed origin on a real request, and exposes the request id", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/health", {
			headers: { origin: TAURI_ORIGIN },
		});
		expect(res.headers.get("access-control-allow-origin")).toBe(TAURI_ORIGIN);
		expect(res.headers.get("access-control-expose-headers")).toContain(
			"x-request-id",
		);
	});

	it("gives an unlisted origin no CORS headers at all", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/health", { headers: { origin: EVIL } });
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		expect(res.headers.get("access-control-allow-credentials")).toBeNull();
	});

	it("gives the app's own origin no CORS headers, because the browser comes through its proxy", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/health", {
			headers: { origin: BASE_URL },
		});
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("sign-in origin check", () => {
	it("starts sign-in for a listed Tauri origin", async () => {
		const { app } = buildApp();
		expect((await startSignIn(app, { origin: TAURI_ORIGIN })).status).toBe(200);
	});

	it("refuses to start sign-in for an unlisted origin", async () => {
		const { app } = buildApp();
		const res = await startSignIn(app, { origin: EVIL });
		expect(res.status).toBe(403);
	});

	it("refuses a sign-in POST that carries no Origin at all", async () => {
		const { app } = buildApp();
		const res = await startSignIn(app, {});
		expect(res.status).toBe(403);
	});
});
