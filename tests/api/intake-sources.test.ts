import { afterAll, describe, expect, it } from "vitest";
import { seedTenants } from "../db/app-role";
import { BASE_URL } from "../unit/support";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

// A brief's sources are chunk ids of the intake's own files. The reads that
// resolve a chunk to its file answer 500 on a hash no file has, so every
// write refuses one. Only the operator, through the review route, confirms
// that a passage supports its item, and approval waits on every source.
describe.skipIf(!process.env.DATABASE_URL)("brief sources", () => {
	afterAll(closeApi);

	const NOTES = "# Hours\n\nOpen 09:00 to 17:00.\n";
	type Source = {
		chunkId: string;
		confirmed: { by: string; at: string } | null;
	};
	const src = (chunkId: string, confirmed: Source["confirmed"] = null) => ({
		chunkId,
		confirmed,
	});
	const briefCiting = (sources: Source[], text = "Book a slot") => ({
		summary: "Booking",
		requirements: [{ id: "R1", text, sources }],
		acceptanceCriteria: [
			{ id: "AC1", requirementId: "R1", text: "A free slot books", sources },
		],
	});
	type Wire = {
		data: { status: string; proposedBrief: ReturnType<typeof briefCiting> };
	};

	async function setUp(h: ApiHarness) {
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
		await upload(b.intakeId);
		const revise = (brief: unknown) =>
			h.call(`/api/intakes/${a.intakeId}`, {
				method: "PATCH",
				body: { proposedBrief: brief },
			});
		const review = (decisions: unknown[]) =>
			h.call(`/api/intakes/${a.intakeId}/sources`, {
				method: "POST",
				body: { decisions },
			});
		const brief = async (res: Response) => {
			expect(res.status, await res.clone().text()).toBe(200);
			return ((await res.json()) as Wire).data;
		};
		return { a, mine, revise, review, brief };
	}

	it("keeps a source from the intake's files, and refuses one from elsewhere or on create", async () => {
		await withApi(async (h) => {
			const { a, mine, revise } = await setUp(h);
			// Halcyon's file has other bytes, so another hash.
			const theirs = `${"f".repeat(64)}:1-3`;

			const kept = await revise(briefCiting([src(mine)]));
			expect(kept.status, await kept.clone().text()).toBe(200);
			expect(
				((await kept.json()) as Wire).data.proposedBrief.requirements[0]
					?.sources,
			).toEqual([src(mine)]);

			const refused = await revise(briefCiting([src(mine), src(theirs)]));
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
					proposedBrief: briefCiting([src(mine)]),
				},
			});
			expect(created.status).toBe(400);
		});
	});

	it("confirms only through review, keeps it while the item is unchanged, and clears it on an edit", async () => {
		await withApi(async (h) => {
			const { mine, revise, review, brief } = await setUp(h);
			const forged = {
				by: await h.operatorId(),
				at: clock.now().toISOString(),
			};

			// A client cannot confirm by writing the brief.
			let b = await brief(await revise(briefCiting([src(mine, forged)])));
			expect(b.proposedBrief.requirements[0]?.sources).toEqual([src(mine)]);

			b = await brief(
				await review([
					{
						list: "requirements",
						itemId: "R1",
						chunkId: mine,
						decision: "confirm",
					},
				]),
			);
			const stamped = {
				by: await h.operatorId(),
				at: clock.now().toISOString(),
			};
			expect(b.proposedBrief.requirements[0]?.sources).toEqual([
				src(mine, stamped),
			]);
			expect(b.proposedBrief.acceptanceCriteria[0]?.sources).toEqual([
				src(mine),
			]);

			// Same text, sent with no confirmation: the stored one stays.
			b = await brief(await revise(briefCiting([src(mine)])));
			expect(b.proposedBrief.requirements[0]?.sources).toEqual([
				src(mine, stamped),
			]);

			// New text: the passage was confirmed for other words.
			b = await brief(
				await revise(briefCiting([src(mine, stamped)], "Book an hour")),
			);
			expect(b.proposedBrief.requirements[0]?.sources).toEqual([src(mine)]);

			// A reject removes the source; a decision on no source refuses.
			b = await brief(
				await review([
					{
						list: "acceptanceCriteria",
						itemId: "AC1",
						chunkId: mine,
						decision: "reject",
					},
				]),
			);
			expect(b.proposedBrief.acceptanceCriteria[0]?.sources).toEqual([]);
			const none = await review([
				{
					list: "acceptanceCriteria",
					itemId: "AC1",
					chunkId: mine,
					decision: "confirm",
				},
			]);
			expect(none.status).toBe(400);
			expect(await none.json()).toMatchObject({
				error: {
					code: "VALIDATION_FAILED",
					details: { body: [{ path: ["decisions", 0] }] },
				},
			});
		});
	});

	it("refuses approval while a source is unconfirmed", async () => {
		await withApi(async (h) => {
			const { a, mine, revise, review } = await setUp(h);
			await revise(briefCiting([src(mine)]));
			const proposed = await h.call(`/api/intakes/${a.intakeId}/propose`, {
				method: "POST",
			});
			expect(proposed.status, await proposed.clone().text()).toBe(200);
			const approve = () =>
				h.call(`/api/intakes/${a.intakeId}/approve`, {
					method: "POST",
					body: {
						missionType: "feature",
						repoUrl: "https://github.com/meridian-co/app",
						acknowledged: [],
					},
				});
			const refused = await approve();
			expect(refused.status).toBe(422);
			expect(await refused.json()).toMatchObject({
				error: {
					details: {
						reason: "brief_sources_unconfirmed",
						issues: [
							{ path: ["proposedBrief", "requirements", 0, "sources", 0] },
							{
								path: ["proposedBrief", "acceptanceCriteria", 0, "sources", 0],
							},
						],
					},
				},
			});
			const reviewed = await review(
				["requirements", "acceptanceCriteria"].map((list, i) => ({
					list,
					itemId: i === 0 ? "R1" : "AC1",
					chunkId: mine,
					decision: "confirm",
				})),
			);
			expect(reviewed.status, await reviewed.clone().text()).toBe(200);
			expect(((await reviewed.json()) as Wire).data.status).toBe("proposed");
			// Past the sources check: this intake's repository was never read.
			expect(await (await approve()).json()).toMatchObject({
				error: { details: { reason: "intake_cut_not_derived" } },
			});
		});
	});
});
