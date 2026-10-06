import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import { BASE_URL, buildApp } from "./support";

// app.request() hands the app a real Request. @hono/node-server hands it a
// lightweight stand-in instead, so only a real socket exercises the path
// src/index.ts serves. That path once answered 500 to every request while the
// in-process tests above it passed.
describe("over a real node server", () => {
	let server: ServerType;
	let base: string;

	beforeAll(async () => {
		const { app } = buildApp();
		await new Promise<void>((resolve) => {
			server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
		});
		base = `http://localhost:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it("answers GET /api/health with 200 and the contract body", async () => {
		const res = await fetch(`${base}/api/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			success: true,
			data: {
				ok: true,
				service: "avel-server",
				time: "2026-10-03T12:00:00.000Z",
				preview: false,
			},
		});
	});

	it("refuses an /api route without a session with the 401 error envelope", async () => {
		const res = await fetch(`${base}/api/nothing-here`);
		expect(res.status).toBe(401);
		const body = errorEnvelope.parse(await res.json());
		expect(body.error.code).toBe("UNAUTHENTICATED");
		expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
	});

	it("serves Better Auth's handler at /api/auth/*", async () => {
		const res = await fetch(`${base}/api/auth/ok`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("starts a GitHub sign-in, reading the JSON body through the real server", async () => {
		const res = await fetch(`${base}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({ provider: "github", callbackURL: "/" }),
		});
		expect(res.status).toBe(200);
		const { url } = (await res.json()) as { url: string };
		expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
	});

	it("answers a body that is not JSON with 400 VALIDATION_FAILED", async () => {
		const res = await fetch(`${base}/api/health`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		expect(errorEnvelope.parse(await res.json()).error.code).toBe(
			"VALIDATION_FAILED",
		);
	});
});
