import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { account, activityLog, session, user } from "../../src/db/schema";
import { STRANGER, signInWithGitHub } from "../unit/support";
import { withApi } from "./support";

describe.skipIf(!process.env.DATABASE_URL)("sign-in against Postgres", () => {
	afterAll(closeDb);

	it("writes user, account and session through the Drizzle adapter, and logs auth.signed_in", async () => {
		await withApi(async ({ tx, signIn }) => {
			await signIn();
			const users = await tx.select().from(user);
			expect(users).toHaveLength(1);
			const [operator] = users;
			expect(operator).toMatchObject({
				githubId: "1001",
				githubLogin: "operator",
				email: "operator@example.com",
			});
			expect(operator?.id).toMatch(/^aaaaaaaa-0000-4000-8000-\d{12}$/);

			const [linked] = await tx
				.select()
				.from(account)
				.where(eq(account.userId, operator?.id ?? ""));
			expect(linked).toMatchObject({ providerId: "github", accountId: "1001" });
			expect(linked?.accessToken).not.toContain("gho_test_token");

			expect(
				await tx
					.select()
					.from(session)
					.where(eq(session.userId, operator?.id ?? "")),
			).toHaveLength(1);

			const logs = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.action, "auth.signed_in"));
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				actorKind: "operator",
				actorUserId: operator?.id,
				entityType: "user",
				entityId: operator?.id,
				// The callback is the app's second request.
				requestId: "00000000-0000-4000-8000-000000000002",
			});
		});
	});

	it("refuses a GitHub account off the allowlist, writing no user, session or log row", async () => {
		await withApi(async ({ tx, app }) => {
			const result = await signInWithGitHub(app, STRANGER);
			expect(result.cookie).toBeNull();
			expect(await tx.select().from(user)).toHaveLength(0);
			expect(await tx.select().from(session)).toHaveLength(0);
			expect(
				await tx
					.select()
					.from(activityLog)
					.where(eq(activityLog.action, "auth.signed_in")),
			).toHaveLength(0);
		});
	});

	it("lets the signed-in operator through and refuses everyone else with 401", async () => {
		await withApi(async ({ app, signIn, call }) => {
			expect((await app.request("/api/clients")).status).toBe(401);
			await signIn();
			expect((await call("/api/clients")).status).toBe(200);
		});
	});
});
