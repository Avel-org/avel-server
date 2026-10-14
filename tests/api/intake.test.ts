import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type BriefInput,
	clientSchema,
	engagementSchema,
	errorEnvelope,
	intakeListEnvelope,
	intakeSchema,
	missionDetail,
	preconditionDetails,
	successEnvelope,
} from "../../src/contract";
import { activityLog, engagement, intake, mission } from "../../src/db/schema";
import { remove } from "../../src/db/schema/columns";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

const url = process.env.DATABASE_URL;

const BRIEF: BriefInput = {
	summary: "Online booking for a salon",
	requirements: [
		{ id: "R1", text: "A customer books a slot" },
		{ id: "R2", text: "The owner sees bookings" },
	],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "A booked slot disappears" },
		{ id: "AC2", requirementId: "R2", text: "The list shows the booking" },
	],
};

const APPROVE = {
	missionType: "full-build",
	repoUrl: "https://github.com/meridian-co/app",
};

type Call = ApiHarness["call"];

async function json<T>(
	res: Response,
	status: number,
	schema: { parse: (v: unknown) => T },
) {
	expect(res.status, await res.clone().text()).toBe(status);
	return schema.parse(await res.json());
}

const one = successEnvelope(intakeSchema);

async function newEngagement(call: Call): Promise<string> {
	const c = await json(
		await call("/api/clients", { method: "POST", body: { name: "Meridian" } }),
		201,
		successEnvelope(clientSchema),
	);
	const e = await json(
		await call("/api/engagements", {
			method: "POST",
			body: { clientId: c.data.id, name: "App build" },
		}),
		201,
		successEnvelope(engagementSchema),
	);
	return e.data.id;
}

async function newIntake(call: Call, body: Record<string, unknown>) {
	return (
		await json(await call("/api/intakes", { method: "POST", body }), 201, one)
	).data;
}

async function post(call: Call, path: string, body?: unknown) {
	return call(path, { method: "POST", body });
}

/** The error envelope, after checking the status. */
async function failure(res: Response, status: number) {
	return (await json(res, status, errorEnvelope)).error;
}

async function withIntake(
	fn: (h: ApiHarness & { engagementId: string }) => Promise<void>,
) {
	await withApi(async (api) => {
		await api.signIn();
		await fn({ ...api, engagementId: await newEngagement(api.call) });
	});
}

/** A proposed intake whose repository has been read, as module 2 will leave it. */
async function readyToApprove(
	h: ApiHarness & { engagementId: string },
	openQuestions: string[] = [],
) {
	const created = await newIntake(h.call, {
		engagementId: h.engagementId,
		sourceMd: "Call notes",
		proposedBrief: BRIEF,
		openQuestions,
	});
	await json(
		await post(h.call, `/api/intakes/${created.id}/propose`),
		200,
		one,
	);
	await h.tx
		.update(intake)
		.set({
			derivedCut: "vertical",
			derivedCutEvidence: "src/features/*",
			repoUrl: APPROVE.repoUrl,
			repoCommitSha: "c".repeat(40),
			repoReadAt: clock.now(),
		})
		.where(eq(intake.id, created.id));
	return created.id;
}

describe.skipIf(!url)("/api/intakes", () => {
	afterAll(closeApi);

	it("refuses every route without a session with 401", async () => {
		await withApi(async (api) => {
			const id = "00000000-0000-4000-8000-000000000001";
			for (const [method, path] of [
				["GET", "/api/intakes"],
				["GET", `/api/intakes/${id}`],
				["POST", "/api/intakes"],
				["PATCH", `/api/intakes/${id}`],
				["POST", `/api/intakes/${id}/propose`],
				["POST", `/api/intakes/${id}/approve`],
				["POST", `/api/intakes/${id}/reject`],
			] as const) {
				const res = await api.app.request(path, { method });
				expect(res.status, `${method} ${path}`).toBe(401);
			}
		});
	});

	it("creates a draft, answers its columns in camelCase, and logs intake.created", async () => {
		await withIntake(async ({ call, engagementId, logRows, operatorId }) => {
			const created = await newIntake(call, {
				engagementId,
				sourceMd: "Call notes",
				proposedBrief: BRIEF,
				openQuestions: ["Deposits?"],
			});
			expect(created).toEqual({
				id: created.id,
				engagementId,
				status: "draft",
				sourceMd: "Call notes",
				proposedBrief: { ...BRIEF, modules: [], checks: [] },
				openQuestions: ["Deposits?"],
				derivedCut: null,
				derivedCutEvidence: null,
				derivedConventions: null,
				derivedBoundaries: null,
				repoUrl: null,
				repoCommitSha: null,
				repoReadAt: null,
				suggestedPresetId: null,
				approvedBy: null,
				approvedAt: null,
				missionId: null,
				createdAt: clock.now().toISOString(),
				updatedAt: clock.now().toISOString(),
			});
			const got = await json(
				await call(`/api/intakes/${created.id}`),
				200,
				one,
			);
			expect(got.data).toEqual(created);
			const rows = await logRows(created.id);
			expect(rows).toMatchObject([
				{
					action: "intake.created",
					entityType: "intake",
					actorKind: "operator",
					actorUserId: await operatorId(),
					engagementId,
					missionId: null,
				},
			]);

			// Optional fields default: no brief, no questions.
			const bare = await newIntake(call, { engagementId, sourceMd: "x" });
			expect(bare.proposedBrief).toBeNull();
			expect(bare.openQuestions).toEqual([]);
		});
	});

	it("refuses a create under a missing or closed engagement with 422", async () => {
		await withIntake(async ({ call, engagementId }) => {
			const missing = "00000000-0000-4000-8000-00000000ffff";
			const notFound = await failure(
				await post(call, "/api/intakes", {
					engagementId: missing,
					sourceMd: "x",
				}),
				422,
			);
			expect(preconditionDetails.parse(notFound.details)).toEqual({
				reason: "engagement_not_found",
				engagementId: missing,
			});

			await post(call, `/api/engagements/${engagementId}/close`);
			const closed = await failure(
				await post(call, "/api/intakes", { engagementId, sourceMd: "x" }),
				422,
			);
			expect(preconditionDetails.parse(closed.details)).toEqual({
				reason: "engagement_closed",
				engagementId,
			});
		});
	});

	it("refuses bodies outside the contract with 400", async () => {
		await withIntake(async ({ call, engagementId }) => {
			for (const body of [
				{ engagementId, sourceMd: "" },
				{ engagementId, sourceMd: "x", extra: 1 },
				{ engagementId, sourceMd: "x", openQuestions: ["a", "a"] },
				{
					engagementId,
					sourceMd: "x",
					proposedBrief: { ...BRIEF, requirements: [{ id: "1", text: "x" }] },
				},
			]) {
				const res = await post(call, "/api/intakes", body);
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
			const id = (await newIntake(call, { engagementId, sourceMd: "x" })).id;
			expect(
				(await call(`/api/intakes/${id}`, { method: "PATCH", body: {} }))
					.status,
			).toBe(400);
			for (const body of [
				{ ...APPROVE, repoUrl: "http://github.com/meridian-co/app" },
				{ ...APPROVE, repoUrl: "not a url" },
				{ repoUrl: APPROVE.repoUrl },
			]) {
				const res = await post(call, `/api/intakes/${id}/approve`, body);
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
			expect(
				(await post(call, `/api/intakes/${id}/reject`, { reason: " " })).status,
			).toBe(400);
		});
	});

	it("answers 404 for an unknown intake, and hides one whose engagement is removed", async () => {
		await withIntake(async ({ call, tx, engagementId }) => {
			const missing = "00000000-0000-4000-8000-00000000ffff";
			await failure(await call(`/api/intakes/${missing}`), 404);
			await failure(await post(call, `/api/intakes/${missing}/propose`), 404);

			const id = (await newIntake(call, { engagementId, sourceMd: "x" })).id;
			await tx
				.update(engagement)
				.set(remove(clock))
				.where(eq(engagement.id, engagementId));
			await failure(await call(`/api/intakes/${id}`), 404);
			const list = await json(
				await call(`/api/intakes?engagementId=${engagementId}`),
				200,
				intakeListEnvelope,
			);
			expect(list.data).toEqual([]);
			expect(list.meta.total).toBe(0);
		});
	});

	it("lists newest first, filters by engagement and status, and pages with a steady total", async () => {
		await withIntake(async ({ call, engagementId }) => {
			const other = await newEngagement(call);
			const a = (await newIntake(call, { engagementId, sourceMd: "a" })).id;
			const b = (await newIntake(call, { engagementId, sourceMd: "b" })).id;
			const c = (await newIntake(call, { engagementId, sourceMd: "c" })).id;
			const elsewhere = (
				await newIntake(call, { engagementId: other, sourceMd: "d" })
			).id;
			await post(call, `/api/intakes/${b}/reject`, { reason: "No budget" });

			const all = await json(
				await call(`/api/intakes?engagementId=${engagementId}`),
				200,
				intakeListEnvelope,
			);
			// Same created_at, so the id breaks the tie, descending.
			expect(all.data.map((i) => i.id)).toEqual([c, b, a]);
			expect(all.meta.total).toBe(3);

			const drafts = await json(
				await call(`/api/intakes?engagementId=${engagementId}&status=draft`),
				200,
				intakeListEnvelope,
			);
			expect(drafts.data.map((i) => i.id)).toEqual([c, a]);
			expect(drafts.meta.total).toBe(2);

			const both = await json(
				await call(
					`/api/intakes?engagementId=${engagementId}&status[0]=rejected&status[1]=draft`,
				),
				200,
				intakeListEnvelope,
			);
			expect(both.meta.total).toBe(3);

			const unfiltered = await json(
				await call("/api/intakes?limit=100"),
				200,
				intakeListEnvelope,
			);
			expect(unfiltered.data.map((i) => i.id)).toContain(elsewhere);

			const seen: string[] = [];
			let cursor: string | null = null;
			do {
				const page: {
					data: Array<{ id: string }>;
					meta: { total: number; nextCursor: string | null };
				} = await json(
					await call(
						`/api/intakes?engagementId=${engagementId}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
					),
					200,
					intakeListEnvelope,
				);
				expect(page.meta.total).toBe(3);
				seen.push(...page.data.map((i) => i.id));
				cursor = page.meta.nextCursor;
			} while (cursor && seen.length < 10);
			expect(seen).toEqual([c, b, a]);
		});
	});

	it("proposes only an intake that passes the check, listing what it found", async () => {
		await withIntake(async ({ call, engagementId, logRows }) => {
			const id = (
				await newIntake(call, {
					engagementId,
					sourceMd: "x",
					proposedBrief: {
						...BRIEF,
						acceptanceCriteria: [BRIEF.acceptanceCriteria[0]],
					},
				})
			).id;
			const refused = await failure(
				await post(call, `/api/intakes/${id}/propose`),
				422,
			);
			expect(preconditionDetails.parse(refused.details)).toEqual({
				reason: "intake_check_failed",
				issues: [
					{
						path: ["proposedBrief", "requirements", 1, "acceptanceCriteria"],
						message: "R2 has no acceptance criterion",
					},
				],
			});
			const still = await json(await call(`/api/intakes/${id}`), 200, one);
			expect(still.data.status).toBe("draft");

			const noBrief = (await newIntake(call, { engagementId, sourceMd: "x" }))
				.id;
			const empty = await failure(
				await post(call, `/api/intakes/${noBrief}/propose`),
				422,
			);
			expect(preconditionDetails.parse(empty.details).issues).toEqual([
				{ path: ["proposedBrief"], message: "There is no brief yet" },
			]);

			await call(`/api/intakes/${id}`, {
				method: "PATCH",
				body: { proposedBrief: BRIEF },
			});
			const proposed = await json(
				await post(call, `/api/intakes/${id}/propose`),
				200,
				one,
			);
			expect(proposed.data.status).toBe("proposed");
			expect((await logRows(id)).map((r) => r.action)).toEqual([
				"intake.created",
				"intake.updated",
				"intake.proposed",
			]);
			await failure(await post(call, `/api/intakes/${id}/propose`), 409);
		});
	});

	it("revises a draft in place and sends a proposed intake back to draft", async () => {
		await withIntake(async ({ call, engagementId, logRows }) => {
			const id = (
				await newIntake(call, {
					engagementId,
					sourceMd: "x",
					proposedBrief: BRIEF,
				})
			).id;
			const draft = await json(
				await call(`/api/intakes/${id}`, {
					method: "PATCH",
					body: { sourceMd: "Longer notes", openQuestions: ["Deposits?"] },
				}),
				200,
				one,
			);
			expect(draft.data).toMatchObject({
				status: "draft",
				sourceMd: "Longer notes",
				openQuestions: ["Deposits?"],
				proposedBrief: BRIEF,
			});

			await post(call, `/api/intakes/${id}/propose`);
			const reopened = await json(
				await call(`/api/intakes/${id}`, {
					method: "PATCH",
					body: { openQuestions: [] },
				}),
				200,
				one,
			);
			expect(reopened.data.status).toBe("draft");
			const updates = (await logRows(id)).filter(
				(r) => r.action === "intake.updated",
			);
			expect(updates.map((r) => r.payload)).toEqual([
				{ fields: ["openQuestions", "sourceMd"], from: "draft" },
				{ fields: ["openQuestions"], from: "proposed" },
			]);
		});
	});

	it("rejects a draft or a proposed intake, and nothing after", async () => {
		await withIntake(async ({ call, engagementId, logRows }) => {
			const draft = (await newIntake(call, { engagementId, sourceMd: "x" })).id;
			const rejected = await json(
				await post(call, `/api/intakes/${draft}/reject`, {
					reason: "No budget",
				}),
				200,
				one,
			);
			expect(rejected.data.status).toBe("rejected");
			expect((await logRows(draft)).at(-1)).toMatchObject({
				action: "intake.rejected",
				payload: { reason: "No budget" },
			});

			const proposed = (
				await newIntake(call, {
					engagementId,
					sourceMd: "x",
					proposedBrief: BRIEF,
				})
			).id;
			await post(call, `/api/intakes/${proposed}/propose`);
			await json(
				await post(call, `/api/intakes/${proposed}/reject`, { reason: "No" }),
				200,
				one,
			);

			for (const [path, body] of [
				[`/api/intakes/${draft}/reject`, { reason: "again" }],
				[`/api/intakes/${draft}/propose`, undefined],
				[`/api/intakes/${draft}/approve`, APPROVE],
			] as const) {
				await failure(await post(call, path, body), 409);
			}
			await failure(
				await call(`/api/intakes/${draft}`, {
					method: "PATCH",
					body: { sourceMd: "late" },
				}),
				409,
			);
		});
	});

	it("approves only a proposed intake whose questions are all acknowledged", async () => {
		await withIntake(async (h) => {
			const draft = (
				await newIntake(h.call, {
					engagementId: h.engagementId,
					sourceMd: "x",
					proposedBrief: BRIEF,
				})
			).id;
			await failure(
				await post(h.call, `/api/intakes/${draft}/approve`, APPROVE),
				409,
			);

			const id = await readyToApprove(h, ["Deposits?", "Which calendar?"]);
			const unacknowledged = await failure(
				await post(h.call, `/api/intakes/${id}/approve`, {
					...APPROVE,
					acknowledged: ["Which calendar?", "Gift cards?"],
				}),
				422,
			);
			expect(preconditionDetails.parse(unacknowledged.details)).toEqual({
				reason: "intake_check_failed",
				issues: [
					{
						path: ["openQuestions", 0],
						message:
							"Open question is neither answered nor acknowledged: Deposits?",
					},
					{
						path: ["acknowledged", 1],
						message: "Acknowledged a question that is not open: Gift cards?",
					},
				],
			});
			const still = await json(await h.call(`/api/intakes/${id}`), 200, one);
			expect(still.data.status).toBe("proposed");
		});
	});

	it("refuses approval while the repository has not been read, so the cut is never chosen", async () => {
		await withIntake(async (h) => {
			const id = await readyToApprove(h);
			await h.tx
				.update(intake)
				.set({ derivedCut: null })
				.where(eq(intake.id, id));
			const refused = await failure(
				await post(h.call, `/api/intakes/${id}/approve`, APPROVE),
				422,
			);
			expect(preconditionDetails.parse(refused.details)).toEqual({
				reason: "intake_cut_not_derived",
				engagementId: h.engagementId,
			});
			const missions = await h.tx
				.select()
				.from(mission)
				.where(eq(mission.engagementId, h.engagementId));
			expect(missions).toEqual([]);
		});
	});

	it("refuses approval once the engagement is closed", async () => {
		await withIntake(async (h) => {
			const id = await readyToApprove(h);
			await post(h.call, `/api/engagements/${h.engagementId}/close`);
			const refused = await failure(
				await post(h.call, `/api/intakes/${id}/approve`, APPROVE),
				422,
			);
			expect(preconditionDetails.parse(refused.details).reason).toBe(
				"engagement_closed",
			);
		});
	});

	it("approves into a draft Mission with the derived cut, in one transaction with its log rows", async () => {
		await withIntake(async (h) => {
			const id = await readyToApprove(h, ["Deposits?"]);
			const approved = await json(
				await post(h.call, `/api/intakes/${id}/approve`, {
					...APPROVE,
					acknowledged: ["Deposits?"],
				}),
				200,
				one,
			);
			const operatorId = await h.operatorId();
			const missionId = approved.data.missionId;
			expect(missionId).not.toBeNull();
			expect(approved.data).toMatchObject({
				status: "approved",
				approvedBy: operatorId,
				approvedAt: clock.now().toISOString(),
			});

			const detail = await json(
				await h.call(`/api/missions/${missionId}`),
				200,
				successEnvelope(missionDetail),
			);
			expect(detail.data).toMatchObject({
				origin: "client",
				type: "full-build",
				sprintN: 1,
				status: "draft",
				cut: "vertical",
				cutSource: "derived",
				cutRationale: null,
				repoUrl: APPROVE.repoUrl,
				brief: BRIEF,
				engagement: { id: h.engagementId },
			});

			const rows = await h.tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.engagementId, h.engagementId));
			const tail = rows
				.filter((r) => r.entityId === id || r.entityId === missionId)
				.slice(-2);
			expect(tail).toMatchObject([
				{
					action: "mission.created",
					entityType: "mission",
					entityId: missionId,
					missionId,
					payload: { intakeId: id, type: "full-build" },
				},
				{
					action: "intake.approved",
					entityType: "intake",
					entityId: id,
					missionId,
					payload: { missionId, acknowledged: ["Deposits?"] },
				},
			]);

			await failure(
				await post(h.call, `/api/intakes/${id}/approve`, APPROVE),
				409,
			);
			await failure(
				await post(h.call, `/api/intakes/${id}/reject`, { reason: "late" }),
				409,
			);
		});
	});
});
