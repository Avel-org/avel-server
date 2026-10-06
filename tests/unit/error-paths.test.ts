import { describe, expect, it } from "vitest";
import {
	type ErrorCode,
	errorEnvelope,
	validationDetails,
} from "../../src/contract";
import type { Clock } from "../../src/lib/clock";
import { statusFor } from "../../src/middleware/errors";
import { BASE_URL, buildApp, OPERATOR, signInWithGitHub } from "./support";

// Every error path that needs no database, through the real app. The error
// body is built by the middleware, not a route, so responseValidation never
// sees it: each one is parsed here against the contract's strict schema.
async function expectEnvelope(res: Response, code: ErrorCode) {
	expect(res.status, code).toBe(statusFor[code]);
	const body = errorEnvelope.parse(await res.json());
	expect(body.error.code).toBe(code);
	return body;
}

describe("error paths without a database", () => {
	it("UNAUTHENTICATED: no session", async () => {
		const { app } = buildApp();
		await expectEnvelope(await app.request("/api/clients"), "UNAUTHENTICATED");
	});

	it("NOT_OPERATOR: a live session off the allowlist", async () => {
		const first = buildApp();
		const { cookie } = await signInWithGitHub(first.app, OPERATOR);
		const later = buildApp({ operators: ["9999"] });
		later.memory.user = first.memory.user ?? [];
		later.memory.session = first.memory.session ?? [];
		await expectEnvelope(
			await later.app.request("/api/clients", {
				headers: { cookie: cookie ?? "" },
			}),
			"NOT_OPERATOR",
		);
	});

	it("FORBIDDEN: a sign-in POST from an untrusted origin", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/auth/sign-in/social", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://evil.example.com",
			},
			body: JSON.stringify({ provider: "github" }),
		});
		await expectEnvelope(res, "FORBIDDEN");
	});

	it("NOT_FOUND: a route the contract does not define", async () => {
		const { app } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		await expectEnvelope(
			await app.request("/api/nothing-here", {
				headers: { cookie: cookie ?? "" },
			}),
			"NOT_FOUND",
		);
	});

	it("VALIDATION_FAILED: a body that is not JSON, with no details", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/health", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{nope",
		});
		const body = await expectEnvelope(res, "VALIDATION_FAILED");
		expect(body.error.details).toBeUndefined();
	});

	it("VALIDATION_FAILED: a query the contract refuses, with typed query issues", async () => {
		const { app } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		const res = await app.request("/api/missions?origin=both", {
			headers: { cookie: cookie ?? "", origin: BASE_URL },
		});
		const body = await expectEnvelope(res, "VALIDATION_FAILED");
		const details = validationDetails.parse(body.error.details);
		expect(details.query?.[0]?.path).toEqual(["origin"]);
	});

	it("INTERNAL: a thrown error", async () => {
		const clock: Clock = {
			now: () => {
				throw new Error("boom");
			},
		};
		const { app } = buildApp({ clock });
		await expectEnvelope(await app.request("/api/health"), "INTERNAL");
	});
});
