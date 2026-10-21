import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type Brief,
	errorEnvelope,
	missionReadiness,
	missionStatusChange,
	READINESS_REASONS,
	successEnvelope,
	WAVES,
} from "../../src/contract";
import { preconditionDetails } from "../../src/contract/shared/errors";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	client,
	engagement,
	mission,
	playbook,
	rosterEntry,
	rosterPreset,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const readinessBody = successEnvelope(missionReadiness);
const changeBody = successEnvelope(missionStatusChange);

const PLANNED: Brief = {
	summary: "Online booking for a salon",
	requirements: [{ id: "R1", text: "A client books a slot" }],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
	],
	modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"], reads: [] }],
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "test", command: "pnpm test R1" },
	],
};

/**
 * A client mission that is ready to start: a passing plan, a playbook whose
 * first wave is B, one active estimated agent in wave B, and a ceiling.
 * Each test breaks one thing.
 */
async function seed(tx: Tx, ns: string) {
	let n = 0xc00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const clientId = id();
	await tx.insert(client).values({
		id: clientId,
		name: `Client ${ns}`,
		status: "active",
		...stamp(clock),
	});
	const engagementId = id();
	await tx.insert(engagement).values({
		id: engagementId,
		clientId,
		name: "Booking",
		status: "active",
		startedAt: clock.now(),
		...stamp(clock),
	});
	const presetId = id();
	await tx.insert(rosterPreset).values({
		id: presetId,
		name: `Preset ${ns}`,
		description: null,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamp(clock),
	});
	const type = `booking-${ns}`;
	await tx.insert(playbook).values({
		id: id(),
		missionType: type,
		name: "Booking",
		wavesApplicable: ["C", "B"],
		gates: [],
		deliverable: "pr",
		requiredFields: [],
		defaultPresetId: presetId,
		version: 1,
		...stamp(clock),
	});
	const templateId = id();
	await tx.insert(agentTemplate).values({
		id: templateId,
		slug: `${ns}-kel`,
		name: "Kel",
		kind: "feature",
		roles: ["domain"],
		waveDefaults: ["B"],
		writablePaths: ["src/**"],
		version: 1,
		...stamp(clock),
	});
	const missionId = id();
	await tx.insert(mission).values({
		id: missionId,
		origin: "client",
		engagementId,
		type,
		brief: PLANNED,
		sprintN: 1,
		status: "draft",
		cut: "horizontal",
		cutSource: "derived",
		repoUrl: "https://github.com/avel-org/app",
		spendCeilingUsd: "25.00",
		...stamp(clock),
	});
	const entryId = id();
	await tx.insert(rosterEntry).values({
		id: entryId,
		missionId,
		agentTemplateId: templateId,
		active: true,
		waves: ["B"],
		territory: "bookings",
		estimatedTokens: 40000,
		grain: "default",
		absorbedBoundaries: [],
		...stamp(clock),
	});
	return { id, missionId, engagementId, templateId, entryId, type };
}

type Call = ApiHarness["call"];

const readiness = async (call: Call, missionId: string) => {
	const res = await call(`/api/missions/${missionId}/readiness`);
	expect(res.status).toBe(200);
	return readinessBody.parse(await res.json()).data;
};

const post = (call: Call, missionId: string, verb: "start" | "halt") =>
	call(`/api/missions/${missionId}/${verb}`, { method: "POST" });

async function refusal(res: Response) {
	expect(res.status).toBe(422);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("PRECONDITION_FAILED");
	return preconditionDetails.parse(error.details);
}

describe.skipIf(!process.env.DATABASE_URL)("mission start and halt", () => {
	afterAll(closeDb);

	it("pins the details wave enum to WAVES", () => {
		expect(preconditionDetails.shape.wave.unwrap().unwrap().options).toEqual([
			...WAVES,
		]);
	});

	it("reads a ready mission as ready, and starts it", async () => {
		await withApi(async ({ signIn, call, tx, ns, operatorId }) => {
			await signIn();
			const s = await seed(tx, ns);
			expect(await readiness(call, s.missionId)).toEqual({
				missionId: s.missionId,
				ready: true,
				blockers: [],
				warnings: [],
			});

			const res = await post(call, s.missionId, "start");
			expect(res.status).toBe(200);
			expect(changeBody.parse(await res.json()).data).toEqual({
				missionId: s.missionId,
				from: "draft",
				to: "active",
				at: clock.now().toISOString(),
			});
			const [m] = await tx
				.select({ status: mission.status })
				.from(mission)
				.where(eq(mission.id, s.missionId));
			expect(m?.status).toBe("active");
			const rows = await tx
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.entityId, s.missionId),
						eq(activityLog.action, "mission.status_changed"),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				actorKind: "operator",
				actorUserId: await operatorId(),
				entityType: "mission",
				missionId: s.missionId,
				engagementId: s.engagementId,
				payload: { from: "draft", to: "active" },
			});
		});
	});

	it("lists every blocker in start's order, and start refuses with the first", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(engagement)
				.set({ status: "closed", closedAt: clock.now() })
				.where(eq(engagement.id, s.engagementId));
			await tx
				.update(mission)
				.set({
					brief: { ...PLANNED, modules: [] },
					spendCeilingUsd: null,
				})
				.where(eq(mission.id, s.missionId));
			await tx
				.update(rosterEntry)
				.set({ waves: ["C"], estimatedTokens: null })
				.where(eq(rosterEntry.id, s.entryId));

			const r = await readiness(call, s.missionId);
			expect(r.ready).toBe(false);
			expect(r.blockers.map((b) => b.reason)).toEqual(
				READINESS_REASONS.filter((x) => x !== "mission_not_draft"),
			);
			expect(r.blockers[0]).toEqual({
				reason: "engagement_closed",
				engagementId: s.engagementId,
			});
			expect(r.blockers[1]?.issues?.map((i) => i.path)).toEqual([
				["brief", "modules"],
				["brief", "requirements", 0],
			]);
			expect(r.blockers[2]).toMatchObject({
				reason: "coherence_blocked",
				wave: "B",
				issues: [{ path: ["coherence", "block"] }],
			});
			expect(r.blockers[3]).toMatchObject({
				reason: "estimate_missing",
				rosterEntryIds: [s.entryId],
				issues: [
					{
						path: ["roster", s.entryId, "estimatedTokens"],
						message: "Kel · bookings has no token estimate",
					},
				],
			});
			// No ceiling is a warning, never a blocker (J, 2026-10-20).
			expect(r.blockers).toHaveLength(4);
			expect(r.warnings).toEqual([{ reason: "spend_ceiling_missing" }]);

			const d = await refusal(await post(call, s.missionId, "start"));
			expect(d).toEqual({
				reason: "engagement_closed",
				engagementId: s.engagementId,
				missionId: s.missionId,
			});
		});
	});

	it("ignores inactive and deleted entries when it asks for estimates", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			for (const over of [{ active: false }, { deletedAt: clock.now() }]) {
				await tx.insert(rosterEntry).values({
					id: s.id(),
					missionId: s.missionId,
					agentTemplateId: s.templateId,
					active: true,
					waves: ["B"],
					grain: "default",
					absorbedBoundaries: [],
					...stamp(clock),
					...over,
				});
			}
			expect((await readiness(call, s.missionId)).ready).toBe(true);
		});
	});

	it("asks no estimate of the operator's foundations entry, which is never dispatched", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const operatorTemplate = s.id();
			await tx.insert(agentTemplate).values({
				id: operatorTemplate,
				slug: `${ns}-operator`,
				name: "Axis",
				kind: "horizontal",
				roles: ["foundations"],
				waveDefaults: ["A"],
				writablePaths: ["docs/**"],
				version: 1,
				...stamp(clock),
			});
			await tx.insert(rosterEntry).values({
				id: s.id(),
				missionId: s.missionId,
				agentTemplateId: operatorTemplate,
				active: true,
				waves: ["A"],
				grain: "default",
				absorbedBoundaries: [],
				...stamp(clock),
			});
			expect((await readiness(call, s.missionId)).ready).toBe(true);
		});
	});

	it("blocks at the playbook when none matches the mission type", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(playbook)
				.set({ deletedAt: clock.now() })
				.where(eq(playbook.missionType, s.type));
			const d = await refusal(await post(call, s.missionId, "start"));
			expect(d.reason).toBe("coherence_blocked");
			expect(d.issues?.map((i) => i.path)).toEqual([["playbook"]]);
			expect(d).not.toHaveProperty("wave");
		});
	});

	it("blocks with wave null when the playbook declares no waves", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(playbook)
				.set({ wavesApplicable: [] })
				.where(eq(playbook.missionType, s.type));
			const d = await refusal(await post(call, s.missionId, "start"));
			expect(d).toMatchObject({ reason: "coherence_blocked", wave: null });
		});
	});

	it("refuses to start twice, and halts only an active mission", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			expect(
				(await refusal(await post(call, s.missionId, "halt"))).reason,
			).toBe("mission_not_active");
			expect((await post(call, s.missionId, "start")).status).toBe(200);
			const again = await refusal(await post(call, s.missionId, "start"));
			expect(again).toEqual({
				reason: "mission_not_draft",
				missionId: s.missionId,
			});

			const res = await post(call, s.missionId, "halt");
			expect(res.status).toBe(200);
			expect(changeBody.parse(await res.json()).data).toMatchObject({
				from: "active",
				to: "halted",
			});
			expect(
				(await refusal(await post(call, s.missionId, "halt"))).reason,
			).toBe("mission_not_active");
			const payloads = (
				await tx
					.select({ payload: activityLog.payload })
					.from(activityLog)
					.where(eq(activityLog.entityId, s.missionId))
			)
				.map((r) => r.payload as { from: string; to: string })
				.sort((a, b) => a.to.localeCompare(b.to));
			expect(payloads).toEqual([
				{ from: "draft", to: "active" },
				{ from: "active", to: "halted" },
			]);
		});
	});

	it("answers 404 for a deleted mission, or one whose client is deleted", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(client)
				.set({ deletedAt: clock.now() })
				.where(eq(client.id, (await clientOf(tx, s.engagementId)) ?? ""));
			for (const verb of ["readiness", "start", "halt"] as const) {
				const res =
					verb === "readiness"
						? await call(`/api/missions/${s.missionId}/readiness`)
						: await post(call, s.missionId, verb);
				expect(res.status, verb).toBe(404);
			}
		});
	});

	it("needs a session to start or halt", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const s = await seed(tx, ns);
			expect((await post(call, s.missionId, "start")).status).toBe(401);
			expect((await post(call, s.missionId, "halt")).status).toBe(401);
		});
	});
});

async function clientOf(tx: Tx, engagementId: string) {
	const [row] = await tx
		.select({ clientId: engagement.clientId })
		.from(engagement)
		.where(eq(engagement.id, engagementId));
	return row?.clientId;
}
