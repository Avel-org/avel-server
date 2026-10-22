import { describe, expect, it } from "vitest";
import { healthResponse, successEnvelope } from "../../src/contract";
import { buildApp } from "./support";

describe("GET /api/health", () => {
	const { app } = buildApp();

	it("answers 200 with a body that satisfies the contract", async () => {
		const res = await app.request("/api/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(successEnvelope(healthResponse).safeParse(body).success).toBe(true);
	});

	it("reports time from the injected clock, so the response is exact", async () => {
		const res = await app.request("/api/health");
		expect(await res.json()).toEqual({
			success: true,
			data: {
				ok: true,
				service: "avel-server",
				time: "2026-10-03T12:00:00.000Z",
			},
		});
	});

	it("answers without a session; other /api routes require one", async () => {
		expect((await app.request("/api/health")).status).toBe(200);
		expect((await app.request("/api/nothing-here")).status).toBe(401);
	});
});
