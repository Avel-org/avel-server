import { afterAll, describe, expect, it } from "vitest";
import { seedTenants } from "../db/app-role";
import { BASE_URL } from "../unit/support";
import { closeApi, withApi } from "./support";

// A brief's sources are chunk ids of the intake's own files. The reads that
// resolve a chunk to its file answer 500 on a hash no file has, so every
// write refuses one.
describe.skipIf(!process.env.DATABASE_URL)("brief sources", () => {
	afterAll(closeApi);

	const NOTES = "# Hours\n\nOpen 09:00 to 17:00.\n";
	const briefCiting = (sources: string[]) => ({
		summary: "Booking",
		requirements: [{ id: "R1", text: "Book a slot", sources }],
		acceptanceCriteria: [
			{ id: "AC1", requirementId: "R1", text: "A free slot books", sources },
		],
	});

	it("keeps a source from the intake's files, and refuses one from elsewhere or on create", async () => {
		await withApi(async (h) => {
			const cookie = await h.signIn();
			const { a, b } = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
			const upload = async (intakeId: string) => {
				const res = await h.app.request(
					`/api/intakes/${intakeId}/files?name=notes.md`,
					{
						method: "POST",
						headers: { cookie, origin: BASE_URL, "content-type": "text/plain" },
						body: NOTES,
					},
				);
				expect(res.status, await res.clone().text()).toBe(201);
				return ((await res.json()) as { data: { sha256: string } }).data.sha256;
			};
			const mine = `${await upload(a.intakeId)}:1-3`;
			// Halcyon's file has other bytes, so another hash.
			const theirs = `${"f".repeat(64)}:1-3`;
			await upload(b.intakeId);

			const revise = (sources: string[]) =>
				h.call(`/api/intakes/${a.intakeId}`, {
					method: "PATCH",
					body: { proposedBrief: briefCiting(sources) },
				});

			const kept = await revise([mine]);
			expect(kept.status, await kept.clone().text()).toBe(200);
			const body = (await kept.json()) as {
				data: { proposedBrief: ReturnType<typeof briefCiting> };
			};
			expect(body.data.proposedBrief.requirements[0]?.sources).toEqual([mine]);

			const refused = await revise([mine, theirs]);
			expect(refused.status).toBe(400);
			expect(await refused.json()).toMatchObject({
				error: {
					code: "VALIDATION_FAILED",
					details: {
						body: [
							{ path: ["proposedBrief", "requirements", 0, "sources", 1] },
							{
								path: ["proposedBrief", "acceptanceCriteria", 0, "sources", 1],
							},
						],
					},
				},
			});

			const created = await h.call("/api/intakes", {
				method: "POST",
				body: {
					engagementId: a.engagementId,
					sourceMd: "notes",
					proposedBrief: briefCiting([mine]),
				},
			});
			expect(created.status).toBe(400);
		});
	});
});
