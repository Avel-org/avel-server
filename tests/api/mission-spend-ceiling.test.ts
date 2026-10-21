import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type BriefInput,
	clientSchema,
	engagementSchema,
	errorEnvelope,
	intakeSchema,
	missionDetail,
	missionReadiness,
	successEnvelope,
} from "../../src/contract";
import { preconditionDetails } from "../../src/contract/shared/errors";
import {
	activityLog,
	agentTemplate,
	engagement,
	intake,
	mission,
	playbook,
	rosterPreset,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

// The spend ceiling: optional at approval, set, raised or cleared afterwards.
// A mission made through the API starts with a plan and a roster, ceiling or
// not; without one readiness warns (J, 2026-10-20). Before this, approval
// wrote null, nothing could set it, and start refused (spend_ceiling_missing).

type Call = ApiHarness["call"];

const REPO = "https://github.com/meridian-co/app";

const BRIEF: BriefInput = {
	summary: "Online booking for a salon",
	requirements: [{ id: "R1", text: "A customer books a slot" }],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "A booked slot disappears" },
	],
};

async function json<T>(
	res: Response,
	status: number,
	schema: { parse: (v: unknown) => T },
) {
	expect(res.status, await res.clone().text()).toBe(status);
	return schema.parse(await res.json());
}

const detailBody = successEnvelope(missionDetail);

async function refusal(res: Response, status = 422) {
	const { error } = await json(res, status, errorEnvelope);
	return error;
}

const setCeiling = (call: Call, missionId: string, body: unknown) =>
	call(`/api/missions/${missionId}`, { method: "PATCH", body });

/**
 * A draft mission made through the routes, from a client to an approved
 * intake. The catalog (a playbook and an agent template) is seeded, and the
 * repository read is written as module 2 leaves it, because it needs GitHub.
 */
async function approvedMission(h: ApiHarness, spendCeilingUsd?: number) {
	const n = (k: number) =>
		`${h.ns}-0000-4000-8000-${(0xd00 + k).toString(16).padStart(12, "0")}`;
	const type = `booking-${h.ns}`;
	await h.tx.insert(rosterPreset).values({
		id: n(1),
		name: `Preset ${h.ns}`,
		description: null,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamp(clock),
	});
	await h.tx.insert(playbook).values({
		id: n(2),
		missionType: type,
		name: "Booking",
		wavesApplicable: ["C", "B"],
		gates: [],
		deliverable: "pr",
		requiredFields: [],
		defaultPresetId: n(1),
		version: 1,
		...stamp(clock),
	});
	const templateId = n(3);
	await h.tx.insert(agentTemplate).values({
		id: templateId,
		slug: `${h.ns}-kel`,
		name: "Kel",
		kind: "feature",
		roles: ["domain"],
		waveDefaults: ["B"],
		writablePaths: ["src/**"],
		version: 1,
		...stamp(clock),
	});

	const c = await json(
		await h.call("/api/clients", {
			method: "POST",
			body: { name: "Meridian" },
		}),
		201,
		successEnvelope(clientSchema),
	);
	const e = await json(
		await h.call("/api/engagements", {
			method: "POST",
			body: { clientId: c.data.id, name: "App build" },
		}),
		201,
		successEnvelope(engagementSchema),
	);
	const one = successEnvelope(intakeSchema);
	const created = await json(
		await h.call("/api/intakes", {
			method: "POST",
			body: {
				engagementId: e.data.id,
				sourceMd: "Call notes",
				proposedBrief: BRIEF,
			},
		}),
		201,
		one,
	);
	await json(
		await h.call(`/api/intakes/${created.data.id}/propose`, { method: "POST" }),
		200,
		one,
	);
	await h.tx
		.update(intake)
		.set({
			derivedCut: "vertical",
			derivedCutEvidence: "src/features/*",
			repoUrl: REPO,
			repoCommitSha: "c".repeat(40),
			repoReadAt: clock.now(),
		})
		.where(eq(intake.id, created.data.id));
	const approved = await json(
		await h.call(`/api/intakes/${created.data.id}/approve`, {
			method: "POST",
			body: { missionType: type, repoUrl: REPO, spendCeilingUsd },
		}),
		200,
		one,
	);
	const missionId = approved.data.missionId;
	if (!missionId) throw new Error("approval made no mission");
	return { missionId, templateId, engagementId: e.data.id };
}

/** Plans the mission and gives it one estimated agent in wave B, through the routes. */
async function makeStartable(
	h: ApiHarness,
	m: { missionId: string; templateId: string },
) {
	const planned = await h.call(`/api/missions/${m.missionId}/plan`, {
		method: "PUT",
		body: {
			brief: {
				...BRIEF,
				modules: [
					{ id: "M1", name: "Booking", requirementIds: ["R1"], reads: [] },
				],
				checks: [
					{
						id: "CK1",
						requirementId: "R1",
						kind: "test",
						command: "pnpm test R1",
					},
				],
			},
			templateRef: null,
			templateVersion: null,
		},
	});
	expect(planned.status, await planned.clone().text()).toBe(200);
	const added = await h.call(`/api/missions/${m.missionId}/roster`, {
		method: "POST",
		body: {
			agentTemplateId: m.templateId,
			waves: ["B"],
			territory: "bookings",
			estimatedTokens: 40_000,
		},
	});
	expect(added.status, await added.clone().text()).toBe(201);
}

const readiness = async (call: Call, missionId: string) =>
	(
		await json(
			await call(`/api/missions/${missionId}/readiness`),
			200,
			successEnvelope(missionReadiness),
		)
	).data;

const ceilingRows = (h: ApiHarness, missionId: string) =>
	h.tx
		.select({
			payload: activityLog.payload,
			actorUserId: activityLog.actorUserId,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.entityId, missionId),
				eq(activityLog.action, "mission.spend_ceiling_set"),
			),
		)
		.orderBy(asc(activityLog.at), asc(activityLog.id));

describe.skipIf(!process.env.DATABASE_URL)("the spend ceiling", () => {
	afterAll(closeApi);

	it("lets a mission made through the API start: approve with a ceiling, plan, roster, start", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await approvedMission(h, 25);
			const detail = await json(
				await h.call(`/api/missions/${m.missionId}`),
				200,
				detailBody,
			);
			expect(detail.data).toMatchObject({
				status: "draft",
				spendCeilingUsd: 25,
			});
			const [created] = await h.tx
				.select({ payload: activityLog.payload })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.entityId, m.missionId),
						eq(activityLog.action, "mission.created"),
					),
				);
			expect(created?.payload).toMatchObject({ spendCeilingUsd: 25 });

			await makeStartable(h, m);
			expect(await readiness(h.call, m.missionId)).toEqual({
				missionId: m.missionId,
				ready: true,
				blockers: [],
				warnings: [],
			});
			const started = await h.call(`/api/missions/${m.missionId}/start`, {
				method: "POST",
			});
			expect(started.status, await started.clone().text()).toBe(200);
			const [row] = await h.tx
				.select({ status: mission.status })
				.from(mission)
				.where(eq(mission.id, m.missionId));
			expect(row?.status).toBe("active");
		});
	});

	it("approves with no ceiling, starts with a warning, and sets, lowers or clears it on a draft", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await approvedMission(h);
			const detail = await json(
				await h.call(`/api/missions/${m.missionId}`),
				200,
				detailBody,
			);
			expect(detail.data).toMatchObject({ spendCeilingUsd: null, spentUsd: 0 });
			await makeStartable(h, m);
			expect(await readiness(h.call, m.missionId)).toEqual({
				missionId: m.missionId,
				ready: true,
				blockers: [],
				warnings: [{ reason: "spend_ceiling_missing" }],
			});

			const set = await json(
				await setCeiling(h.call, m.missionId, { spendCeilingUsd: 30.5 }),
				200,
				detailBody,
			);
			expect(set.data.spendCeilingUsd).toBe(30.5);
			expect((await readiness(h.call, m.missionId)).warnings).toEqual([]);
			// A draft may go down as well as up, and back to no ceiling.
			for (const spendCeilingUsd of [10, null]) {
				await json(
					await setCeiling(h.call, m.missionId, { spendCeilingUsd }),
					200,
					detailBody,
				);
			}
			const operatorId = await h.operatorId();
			expect(await ceilingRows(h, m.missionId)).toEqual([
				{ payload: { from: null, to: 30.5 }, actorUserId: operatorId },
				{ payload: { from: 30.5, to: 10 }, actorUserId: operatorId },
				{ payload: { from: 10, to: null }, actorUserId: operatorId },
			]);

			// It starts with no ceiling; once active, one can still be added.
			const started = await h.call(`/api/missions/${m.missionId}/start`, {
				method: "POST",
			});
			expect(started.status, await started.clone().text()).toBe(200);
			const capped = await json(
				await setCeiling(h.call, m.missionId, { spendCeilingUsd: 50 }),
				200,
				detailBody,
			);
			expect(capped.data).toMatchObject({
				status: "active",
				spendCeilingUsd: 50,
			});
		});
	});

	it("only raises an active mission's ceiling, and the same value again changes nothing", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await approvedMission(h, 25);
			await makeStartable(h, m);
			const started = await h.call(`/api/missions/${m.missionId}/start`, {
				method: "POST",
			});
			expect(started.status).toBe(200);

			const lowered = await refusal(
				await setCeiling(h.call, m.missionId, { spendCeilingUsd: 24.99 }),
			);
			expect(lowered.code).toBe("PRECONDITION_FAILED");
			expect(preconditionDetails.parse(lowered.details).reason).toBe(
				"spend_ceiling_not_raised",
			);
			// Clearing would remove the only cap on the mission's total.
			const cleared = await refusal(
				await setCeiling(h.call, m.missionId, { spendCeilingUsd: null }),
			);
			expect(preconditionDetails.parse(cleared.details).reason).toBe(
				"spend_ceiling_not_raised",
			);

			const same = await json(
				await setCeiling(h.call, m.missionId, { spendCeilingUsd: 25 }),
				200,
				detailBody,
			);
			expect(same.data.spendCeilingUsd).toBe(25);
			expect(await ceilingRows(h, m.missionId)).toEqual([]);

			const raised = await json(
				await setCeiling(h.call, m.missionId, { spendCeilingUsd: 60 }),
				200,
				detailBody,
			);
			expect(raised.data).toMatchObject({
				status: "active",
				spendCeilingUsd: 60,
			});
			expect((await ceilingRows(h, m.missionId)).map((r) => r.payload)).toEqual(
				[{ from: 25, to: 60 }],
			);
		});
	});

	it("never changes a halted, shipped or archived mission's ceiling", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await approvedMission(h, 25);
			for (const status of ["halted", "shipped", "archived"] as const) {
				await h.tx
					.update(mission)
					.set({ status })
					.where(eq(mission.id, m.missionId));
				const refused = await refusal(
					await setCeiling(h.call, m.missionId, { spendCeilingUsd: 99 }),
				);
				expect(preconditionDetails.parse(refused.details).reason).toBe(
					"mission_not_editable",
				);
			}
			const [row] = await h.tx
				.select({ spendCeilingUsd: mission.spendCeilingUsd })
				.from(mission)
				.where(eq(mission.id, m.missionId));
			expect(row?.spendCeilingUsd).toBe("25.00");
			expect(await ceilingRows(h, m.missionId)).toEqual([]);
		});
	});

	it("refuses a bad value with 400, and an unknown or removed mission with 404", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await approvedMission(h, 25);
			for (const body of [
				{},
				{ spendCeilingUsd: 0 },
				{ spendCeilingUsd: -1 },
				{ spendCeilingUsd: 0.001 },
				{ spendCeilingUsd: "30" },
				{ spendCeilingUsd: 1_000_000.01 },
				{ spendCeilingUsd: 30, status: "active" },
			]) {
				const res = await setCeiling(h.call, m.missionId, body);
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
			const unknown = `${h.ns}-0000-4000-8000-00000000ffff`;
			expect(
				(await setCeiling(h.call, unknown, { spendCeilingUsd: 30 })).status,
			).toBe(404);
			// A client mission whose engagement is removed is 404, as GET is.
			await h.tx
				.update(engagement)
				.set(remove(clock))
				.where(eq(engagement.id, m.engagementId));
			expect((await h.call(`/api/missions/${m.missionId}`)).status).toBe(404);
			expect(
				(await setCeiling(h.call, m.missionId, { spendCeilingUsd: 30 })).status,
			).toBe(404);
			expect(await ceilingRows(h, m.missionId)).toEqual([]);
		});
	});

	it("needs a session", async () => {
		await withApi(async (h) => {
			const res = await h.app.request(
				`/api/missions/${h.ns}-0000-4000-8000-000000000001`,
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ spendCeilingUsd: 30 }),
				},
			);
			expect(res.status).toBe(401);
		});
	});
});
