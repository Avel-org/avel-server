import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import {
	type ClientId,
	clientIdOfClient,
	clientIdOfEngagement,
	clientIdOfIntake,
} from "../../src/db/client-id";
import { withClientScope } from "../../src/db/tx";
import { seedTenants } from "./app-role";
import { inRollback } from "./fixtures";

describe.skipIf(!process.env.DATABASE_URL)("ClientId", () => {
	afterAll(closeDb);

	it("comes from the client, engagement or intake row, and is null for a row that does not exist", async () => {
		await inRollback(async (tx) => {
			const { a } = await seedTenants(tx, ["Meridian"]);
			expect(await clientIdOfClient(tx, a.clientId)).toBe(a.clientId);
			expect(await clientIdOfEngagement(tx, a.engagementId)).toBe(a.clientId);
			expect(await clientIdOfIntake(tx, a.intakeId)).toBe(a.clientId);
			for (const lookup of [
				clientIdOfClient,
				clientIdOfEngagement,
				clientIdOfIntake,
			]) {
				expect(await lookup(tx, randomUUID())).toBeNull();
			}
		});
	});

	it("is the only thing withClientScope takes", async () => {
		await inRollback(async (tx) => {
			const { a } = await seedTenants(tx, ["Meridian"]);
			// A plain string, from a body or a model, does not compile.
			// @ts-expect-error a string is not a ClientId
			const fromBody: ClientId = a.clientId;
			await expect(
				// @ts-expect-error a string is not a ClientId
				withClientScope(tx, String(fromBody), async () => {}),
			).resolves.toBeUndefined();
		});
	});
});
