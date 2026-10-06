import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, OPERATOR, signInWithGitHub } from "./support";

// Better Auth reads its own clock (Date), not the injected one, so the only
// way to move "now" past its updateAge is to fake Date itself.
const DAY_MS = 24 * 60 * 60 * 1000;

describe("session sliding through the auth middleware", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("forwards the refreshed session cookie once updateAge has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
		const { app, memory } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		const before = memory.session?.[0]?.expiresAt as Date;

		// Two days later: past the default updateAge (1 day), inside expiresIn (7 days).
		vi.setSystemTime(new Date("2026-10-03T09:00:00.000Z"));
		const res = await app.request("/api/nothing-here", {
			headers: { cookie: cookie ?? "" },
		});
		expect(res.status).toBe(404);

		const after = memory.session?.[0]?.expiresAt as Date;
		expect(after.getTime() - before.getTime()).toBe(2 * DAY_MS);

		const refreshed = res.headers
			.getSetCookie()
			.find((c) => c.includes("session_token="));
		expect(
			refreshed,
			"a refreshed session cookie on the response",
		).toBeDefined();
		expect(refreshed).toMatch(/Max-Age=604800/i);
	});

	it("sends no cookie when the session is still fresh", async () => {
		const { app } = buildApp();
		const { cookie } = await signInWithGitHub(app, OPERATOR);
		const res = await app.request("/api/nothing-here", {
			headers: { cookie: cookie ?? "" },
		});
		expect(
			res.headers.getSetCookie().filter((c) => c.includes("session_token=")),
		).toEqual([]);
	});
});
