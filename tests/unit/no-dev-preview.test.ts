import { describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import { buildApp } from "./support";

// Dev preview (AVEL_DEV_PREVIEW, sessionless reads) was removed on
// 2026-10-21. Every /api route but health and sign-in needs a session,
// whatever the method, and nothing marks an answer as a preview.
describe("no sessionless reads", () => {
	it.each([
		"GET",
		"HEAD",
	])("refuses a sessionless %s with 401, on a real route and an unknown one", async (method) => {
		const { app } = buildApp();
		for (const path of [
			"/api/clients",
			"/api/missions?origin=client",
			"/api/nothing-here",
		]) {
			const res = await app.request(path, { method });
			expect(res.status, `${method} ${path}`).toBe(401);
			expect(res.headers.get("x-avel-preview")).toBeNull();
			if (method === "GET") {
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"UNAUTHENTICATED",
				);
			}
		}
	});

	it("reports health without a preview field or header", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/health");
		expect(res.headers.get("x-avel-preview")).toBeNull();
		expect(await res.json()).toEqual({
			success: true,
			data: {
				ok: true,
				service: "avel-server",
				time: "2026-10-03T12:00:00.000Z",
			},
		});
	});
});
