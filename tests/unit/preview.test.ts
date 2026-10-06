import { describe, expect, it } from "vitest";
import {
	errorEnvelope,
	healthResponse,
	successEnvelope,
} from "../../src/contract";
import { BASE_URL, buildApp, OPERATOR, signInWithGitHub } from "./support";

const health = successEnvelope(healthResponse);

describe("dev preview off (the default)", () => {
	it("refuses a sessionless GET with 401 and sends no preview header", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/missions?origin=client");
		expect(res.status).toBe(401);
		expect(res.headers.get("x-avel-preview")).toBeNull();
	});

	it("reports preview false on health", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/health");
		expect(health.parse(await res.json()).data.preview).toBe(false);
		expect(res.headers.get("x-avel-preview")).toBeNull();
	});
});

describe("dev preview on", () => {
	it("reports preview true on health, with the header", async () => {
		const { app } = buildApp({ preview: true });
		const res = await app.request("/api/health");
		expect(health.parse(await res.json()).data.preview).toBe(true);
		expect(res.headers.get("x-avel-preview")).toBe("1");
	});

	it("lets a sessionless GET and HEAD past auth", async () => {
		const { app } = buildApp({ preview: true });
		// Past auth, the router answers: no such route.
		const get = await app.request("/api/nothing-here");
		expect(get.status).toBe(404);
		expect(get.headers.get("x-avel-preview")).toBe("1");
		expect(
			(await app.request("/api/nothing-here", { method: "HEAD" })).status,
		).toBe(404);
	});

	it.each([
		"POST",
		"PATCH",
		"DELETE",
		"PUT",
	])("still refuses a sessionless %s with 401, header included", async (method) => {
		const { app } = buildApp({ preview: true });
		const res = await app.request("/api/clients", {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(401);
		expect(errorEnvelope.parse(await res.json()).error.code).toBe(
			"UNAUTHENTICATED",
		);
		expect(res.headers.get("x-avel-preview")).toBe("1");
	});

	it("still checks a real session against the allowlist: NOT_OPERATOR", async () => {
		const first = buildApp();
		const { cookie } = await signInWithGitHub(first.app, OPERATOR);
		const later = buildApp({ preview: true, operators: ["9999"] });
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

	it("answers 404 for GitHub sign-in when preview started without credentials", async () => {
		const { app } = buildApp({ preview: true, signInDisabled: true });
		const res = await app.request("/api/auth/sign-in/social", {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({ provider: "github", callbackURL: "/" }),
		});
		expect(res.status).toBe(404);
		expect(
			(await app.request("/api/auth/callback/github?code=x&state=y")).status,
		).toBe(404);
	});
});
