import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	findingListEnvelope,
	finding as findingSchema,
	preconditionDetails,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { activityLog, finding, mission } from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { seedIds, seedRosteredAgent } from "./agent-fixtures";
import { clock, withApi } from "./support";

// The operator's triage of judges' findings (module 9): list with counts,
// confirm, dismiss with a reason. Only an open finding moves.

const one = successEnvelope(findingSchema);

async function seedFinding(
	tx: Tx,
	id: string,
	missionId: string,
	at: Date,
	status: "open" | "confirmed" | "dismissed" = "open",
) {
	await tx.insert(finding).values({
		id,
		missionId,
		clientId: null,
		rule: "Every route checks the caller's tenant",
		subject: `src/routes/a.ts (${id.slice(-2)})`,
		severity: "high",
		class: "authorization",
		status,
		dismissedReason: status === "dismissed" ? "Not a defect" : null,
		caughtBy: "zane",
		reportedByDispatchId: null,
		idempotencyKey: null,
		requestSha256: null,
		...stamp(clock),
		createdAt: at,
		updatedAt: at,
	});
}

const at = (s: number) => new Date(clock.now().getTime() - s * 1000);

describe.skipIf(!process.env.DATABASE_URL)("/api findings triage", () => {
	afterAll(closeDb);

	it("lists a mission's findings newest first, filters by status, and counts every status", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const ids = seedIds(ns);
			const { missionId } = await seedRosteredAgent(tx, ids, ["domain"]);
			const [a, b, c] = [ids.next(), ids.next(), ids.next()];
			await seedFinding(tx, a, missionId, at(30));
			await seedFinding(tx, b, missionId, at(20), "confirmed");
			await seedFinding(tx, c, missionId, at(10));

			const all = findingListEnvelope.parse(
				await (await call(`/api/missions/${missionId}/findings`)).json(),
			);
			expect(all.data.map((f) => f.id)).toEqual([c, b, a]);
			expect(all.meta.counts).toEqual({ open: 2, confirmed: 1, dismissed: 0 });
			expect(all.meta.total).toBe(3);

			const open = findingListEnvelope.parse(
				await (
					await call(`/api/missions/${missionId}/findings?status=open&limit=1`)
				).json(),
			);
			expect(open.data.map((f) => f.id)).toEqual([c]);
			expect(open.meta.total).toBe(2);
			expect(open.meta.counts).toEqual({ open: 2, confirmed: 1, dismissed: 0 });
			const next = findingListEnvelope.parse(
				await (
					await call(
						`/api/missions/${missionId}/findings?status=open&limit=1&cursor=${open.meta.nextCursor}`,
					)
				).json(),
			);
			expect(next.data.map((f) => f.id)).toEqual([a]);
			expect(next.meta.nextCursor).toBeNull();
		});
	});

	it("confirms and dismisses an open finding once, logging each, and refuses a second move", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const ids = seedIds(ns);
			const { missionId } = await seedRosteredAgent(tx, ids, ["domain"]);
			const [a, b] = [ids.next(), ids.next()];
			await seedFinding(tx, a, missionId, at(20));
			await seedFinding(tx, b, missionId, at(10));

			const confirmed = one.parse(
				await (
					await call(`/api/findings/${a}/confirm`, { method: "POST" })
				).json(),
			);
			expect(confirmed.data.status).toBe("confirmed");
			expect(confirmed.data.dismissedReason).toBeNull();

			const dismissed = one.parse(
				await (
					await call(`/api/findings/${b}/dismiss`, {
						method: "POST",
						body: { reason: "  The route is internal only  " },
					})
				).json(),
			);
			expect(dismissed.data.status).toBe("dismissed");
			expect(dismissed.data.dismissedReason).toBe("The route is internal only");

			for (const [path, body] of [
				[`/api/findings/${a}/confirm`, undefined],
				[`/api/findings/${a}/dismiss`, { reason: "late" }],
				[`/api/findings/${b}/confirm`, undefined],
			] as const) {
				const res = await call(path, { method: "POST", body });
				expect(res.status, path).toBe(422);
				const err = errorEnvelope.parse(await res.json()).error;
				expect(preconditionDetails.parse(err.details)).toMatchObject({
					reason: "finding_not_open",
				});
			}

			const rows = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.missionId, missionId));
			const triage = rows
				.filter((r) => r.action.startsWith("finding."))
				.map((r) => ({
					action: r.action,
					entityId: r.entityId,
					actorUserId: r.actorUserId,
					payload: r.payload,
				}));
			const operator = await operatorId();
			expect(triage).toEqual(
				expect.arrayContaining([
					{
						action: "finding.confirmed",
						entityId: a,
						actorUserId: operator,
						payload: { from: "open", to: "confirmed" },
					},
					{
						action: "finding.dismissed",
						entityId: b,
						actorUserId: operator,
						payload: {
							from: "open",
							to: "dismissed",
							reason: "The route is internal only",
						},
					},
				]),
			);
			expect(triage).toHaveLength(2);
		});
	});

	it("answers 404 for an unknown finding or mission, and for a removed mission", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const ids = seedIds(ns);
			const { missionId } = await seedRosteredAgent(tx, ids, ["domain"]);
			const f = ids.next();
			await seedFinding(tx, f, missionId, at(10));
			const missing = "00000000-0000-4000-8000-00000000ffff";
			for (const [path, method] of [
				[`/api/findings/${missing}/confirm`, "POST"],
				[`/api/missions/${missing}/findings`, "GET"],
			] as const) {
				expect((await call(path, { method })).status, path).toBe(404);
			}
			await tx
				.update(mission)
				.set(remove(clock))
				.where(eq(mission.id, missionId));
			expect((await call(`/api/missions/${missionId}/findings`)).status).toBe(
				404,
			);
			expect(
				(await call(`/api/findings/${f}/confirm`, { method: "POST" })).status,
			).toBe(404);
		});
	});

	it("refuses an empty dismissal reason with 400", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const ids = seedIds(ns);
			const { missionId } = await seedRosteredAgent(tx, ids, ["domain"]);
			const f = ids.next();
			await seedFinding(tx, f, missionId, at(10));
			for (const body of [{}, { reason: "   " }, { reason: "x", extra: 1 }]) {
				const res = await call(`/api/findings/${f}/dismiss`, {
					method: "POST",
					body,
				});
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
		});
	});
});
