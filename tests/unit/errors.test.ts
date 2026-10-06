import { describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import type { Clock } from "../../src/lib/clock";
import type { IdGenerator } from "../../src/lib/ids";
import { buildApp, OPERATOR, signInWithGitHub } from "./support";

function build(overrides: { clock?: Clock; ids?: IdGenerator } = {}) {
	const built = buildApp(overrides);
	// Pino's error level is 50.
	const errorsLogged = () => built.logs.filter((line) => line.level === 50);
	return { ...built, errorsLogged };
}

/** Signs in through the app. Sign-in takes two requests, so the next request id is ...0003. */
async function signedIn() {
	const built = build();
	const { cookie } = await signInWithGitHub(built.app, OPERATOR);
	return { ...built, headers: { cookie: cookie ?? "" } };
}

// parse() throws on a body that is not the error envelope, failing the test.
async function envelopeOf(res: Response) {
	return errorEnvelope.parse(await res.json());
}

describe("error envelope under /api/*", () => {
	it("answers an unknown route with 404 NOT_FOUND and the request id", async () => {
		const { app, headers } = await signedIn();
		const res = await app.request("/api/nothing-here", { headers });
		expect(res.status).toBe(404);
		expect(res.headers.get("x-request-id")).toBe(
			"00000000-0000-4000-8000-000000000003",
		);
		expect(await envelopeOf(res)).toEqual({
			success: false,
			error: {
				code: "NOT_FOUND",
				message: "No route for GET /api/nothing-here",
				requestId: "00000000-0000-4000-8000-000000000003",
			},
		});
	});

	it("answers a known path with the wrong method as 404 NOT_FOUND", async () => {
		const { app } = build();
		const res = await app.request("/api/health", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect((await envelopeOf(res)).error.code).toBe("NOT_FOUND");
	});

	it("answers /api itself as 404 NOT_FOUND", async () => {
		const { app, headers } = await signedIn();
		const res = await app.request("/api", { headers });
		expect(res.status).toBe(404);
		expect((await envelopeOf(res)).error.code).toBe("NOT_FOUND");
	});

	it("answers a body that is not JSON with 400 VALIDATION_FAILED", async () => {
		const { app, errorsLogged } = build();
		const res = await app.request("/api/health", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		const body = await envelopeOf(res);
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.requestId).toBe("00000000-0000-4000-8000-000000000001");
		expect(errorsLogged()).toHaveLength(0);
	});

	it("answers a thrown error with 500 INTERNAL, logs it with the request id, and leaks nothing", async () => {
		const secret = "db password is hunter2";
		const clock: Clock = {
			now: () => {
				throw new Error(secret);
			},
		};
		const { app, errorsLogged } = build({ clock });
		const res = await app.request("/api/health");
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain(secret);
		expect(text).not.toContain("at ");
		expect(JSON.parse(text)).toEqual({
			success: false,
			error: {
				code: "INTERNAL",
				message: "Internal server error",
				requestId: "00000000-0000-4000-8000-000000000001",
			},
		});
		const logged = errorsLogged();
		expect(logged).toHaveLength(1);
		expect(logged[0]?.requestId).toBe("00000000-0000-4000-8000-000000000001");
		expect(JSON.stringify(logged[0])).toContain(secret);
	});

	it("still answers with the envelope when the id generator itself fails", async () => {
		const ids: IdGenerator = {
			next: () => {
				throw new Error("entropy gone");
			},
		};
		const { app, errorsLogged } = build({ ids });
		const res = await app.request("/api/health");
		expect(res.status).toBe(500);
		const body = await envelopeOf(res);
		expect(body.error.code).toBe("INTERNAL");
		expect(body.error.requestId).toBe("unavailable");
		expect(errorsLogged()).toHaveLength(1);
	});

	it("answers 500 INTERNAL when a handler's body breaks the contract (response validation)", async () => {
		// Year +275760: toISOString() gives "+275760-09-13T00:00:00.000Z", which
		// the contract's datetime refuses. Without response validation this
		// would go out as a 200 the client's types do not describe.
		const clock: Clock = { now: () => new Date(8.64e15) };
		const { app, errorsLogged } = build({ clock });
		const res = await app.request("/api/health");
		expect(res.status).toBe(500);
		expect((await envelopeOf(res)).error.code).toBe("INTERNAL");
		expect(errorsLogged()).toHaveLength(1);
	});

	it("gives each request its own id", async () => {
		const { app } = build();
		await app.request("/api/health");
		const res = await app.request("/api/nothing-here");
		expect((await envelopeOf(res)).error.requestId).toBe(
			"00000000-0000-4000-8000-000000000002",
		);
	});
});
