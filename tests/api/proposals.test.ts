import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	preconditionDetails,
	proposalListEnvelope,
	proposalSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { proposal } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { runnerIds } from "./runner-fixtures";
import { clock, withApi } from "./support";

// The proposal queue (module 14; J, 2026-10-24). No source writes proposals
// yet, so these tests insert them as a source would.

async function reasonOf(res: Response) {
	expect(res.status, await res.clone().text()).toBe(422);
	return preconditionDetails.parse(
		errorEnvelope.parse(await res.json()).error.details,
	).reason;
}

describe.skipIf(!process.env.DATABASE_URL)("/api/proposals", () => {
	afterAll(closeDb);

	it("lists proposals newest first with counts, dismisses a pending one once, and refuses every approval", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const ids = runnerIds(h.ns);

			// Empty is the correct state while nothing writes proposals.
			const empty = proposalListEnvelope.parse(
				await (await h.call("/api/proposals")).json(),
			);
			expect(empty.data).toEqual([]);
			expect(empty.meta.counts).toEqual({
				pending: 0,
				approved: 0,
				dismissed: 0,
				expired: 0,
			});

			const row = (summary: string, at: string) => ({
				id: ids.next(),
				kind: "calibration" as const,
				source: "code" as const,
				summary,
				payload: { estimate: 50_000 },
				premise: { missed: 3 },
				status: "pending" as const,
				...stamp(clock),
				createdAt: new Date(at),
				updatedAt: new Date(at),
			});
			const older = row("Older", "2026-10-01T00:00:00.000Z");
			const newer = row("Newer", "2026-10-02T00:00:00.000Z");
			await h.tx.insert(proposal).values([older, newer]);

			const listed = proposalListEnvelope.parse(
				await (await h.call("/api/proposals")).json(),
			);
			expect(listed.data.map((p) => p.summary)).toEqual(["Newer", "Older"]);
			expect(listed.meta.counts.pending).toBe(2);
			expect(listed.meta.total).toBe(2);

			const approve = await h.call(`/api/proposals/${older.id}/approve`, {
				method: "POST",
			});
			expect(await reasonOf(approve)).toBe("proposal_action_not_built");

			const noReason = await h.call(`/api/proposals/${older.id}/dismiss`, {
				method: "POST",
				body: { reason: "  " },
			});
			expect(noReason.status).toBe(400);

			const dismissed = await h.call(`/api/proposals/${older.id}/dismiss`, {
				method: "POST",
				body: { reason: "The estimate was right; the module was new." },
			});
			expect(dismissed.status, await dismissed.clone().text()).toBe(200);
			const wire = successEnvelope(proposalSchema).parse(
				await dismissed.json(),
			).data;
			expect(wire).toMatchObject({
				status: "dismissed",
				reason: "The estimate was right; the module was new.",
				decidedBy: await h.operatorId(),
				decidedAt: clock.now().toISOString(),
			});
			const [logged] = await h.logRows(older.id);
			expect(logged).toMatchObject({
				action: "proposal.dismissed",
				entityType: "proposal",
				actorKind: "operator",
			});

			const again = await h.call(`/api/proposals/${older.id}/dismiss`, {
				method: "POST",
				body: { reason: "Twice" },
			});
			expect(await reasonOf(again)).toBe("proposal_not_pending");
			const approveDecided = await h.call(
				`/api/proposals/${older.id}/approve`,
				{ method: "POST" },
			);
			expect(await reasonOf(approveDecided)).toBe("proposal_not_pending");

			const pendingOnly = proposalListEnvelope.parse(
				await (await h.call("/api/proposals?status=pending")).json(),
			);
			expect(pendingOnly.data.map((p) => p.id)).toEqual([newer.id]);
			expect(pendingOnly.meta.total).toBe(1);
			expect(pendingOnly.meta.counts).toMatchObject({
				pending: 1,
				dismissed: 1,
			});

			const missing = await h.call(`/api/proposals/${ids.next()}/dismiss`, {
				method: "POST",
				body: { reason: "Gone" },
			});
			expect(missing.status).toBe(404);
		});
	});
});
