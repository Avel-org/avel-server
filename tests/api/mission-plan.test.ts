import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type Brief,
	errorEnvelope,
	missionPlanSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { client, engagement, intake, mission } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const one = successEnvelope(missionPlanSchema);
const SHA = "0123456789abcdef0123456789abcdef01234567";

const APPROVED: Brief = {
	summary: "Online booking for a salon",
	requirements: [
		{ id: "R1", text: "A client books a slot" },
		{ id: "R2", text: "A stylist sees the day's bookings" },
	],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
		{ id: "AC2", requirementId: "R2", text: "The day view lists bookings" },
	],
	modules: [],
};

const PLANNED: Brief = {
	...APPROVED,
	modules: [
		{ id: "M1", name: "Booking", requirementIds: ["R1"] },
		{ id: "M2", name: "Schedule", requirementIds: ["R2"] },
	],
};

/** A client mission created by an approved intake, plus an internal and an active one. */
async function seed(tx: Tx, ns: string, approvedBy: string) {
	let n = 0xa00;
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
	const newMission = async (
		over: Partial<typeof mission.$inferInsert> = {},
	) => {
		const missionId = id();
		await tx.insert(mission).values({
			id: missionId,
			origin: "client",
			engagementId,
			type: "full-build",
			brief: APPROVED,
			sprintN: 1,
			status: "draft",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			...stamp(clock),
			...over,
		});
		return missionId;
	};
	const draft = await newMission();
	await tx.insert(intake).values({
		id: id(),
		engagementId,
		status: "approved",
		sourceMd: "notes",
		proposedBrief: APPROVED,
		openQuestions: [],
		approvedBy,
		approvedAt: clock.now(),
		missionId: draft,
		...stamp(clock),
	});
	const internal = await newMission({
		origin: "internal",
		engagementId: null,
		brief: { summary: "Seeded before the brief shape" },
	});
	const active = await newMission({ status: "active" });
	const deleted = await newMission({ deletedAt: clock.now() });
	return { draft, internal, active, deleted };
}

type Call = ApiHarness["call"];

function put(call: Call, missionId: string, body: object) {
	return call(`/api/missions/${missionId}/plan`, { method: "PUT", body });
}

async function expectReason(res: Response, reason: string) {
	expect(res.status).toBe(422);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("PRECONDITION_FAILED");
	expect(error.details).toMatchObject({ reason });
	return error;
}

describe.skipIf(!process.env.DATABASE_URL)("mission plan", () => {
	afterAll(closeDb);

	it("reads the approved brief with no modules as a plan that does not pass yet", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await call(`/api/missions/${s.draft}/plan`);
			expect(res.status).toBe(200);
			const plan = one.parse(await res.json()).data;
			expect(plan).toMatchObject({
				missionId: s.draft,
				brief: APPROVED,
				approvedBrief: APPROVED,
				templateRef: null,
				templateVersion: null,
				check: { passed: false },
			});
			expect(plan.check.issues.map((i) => i.message)).toEqual([
				"The plan has no modules",
				"R1 is in no module",
				"R2 is in no module",
			]);
		});
	});

	it("reads a brief that predates the shape as null, without failing", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await call(`/api/missions/${s.internal}/plan`);
			expect(res.status).toBe(200);
			const plan = one.parse(await res.json()).data;
			expect(plan.brief).toBeNull();
			expect(plan.approvedBrief).toBeNull();
			expect(plan.check.passed).toBe(false);
		});
	});

	it("saves modules and the template, passes the check, and logs it", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await put(call, s.draft, {
				brief: PLANNED,
				templateRef: "template-booking",
				templateVersion: SHA,
			});
			expect(res.status).toBe(200);
			const plan = one.parse(await res.json()).data;
			expect(plan).toEqual({
				missionId: s.draft,
				brief: PLANNED,
				approvedBrief: APPROVED,
				templateRef: "template-booking",
				templateVersion: SHA,
				check: { passed: true, issues: [] },
			});
			const [row] = await tx
				.select()
				.from(mission)
				.where(eq(mission.id, s.draft));
			expect(row?.templateRef).toBe("template-booking");
			expect(row?.templateVersion).toBe(SHA);
			const logs = await logRows(s.draft);
			expect(logs.map((l) => l.action)).toEqual(["mission.plan_updated"]);
			expect(logs[0]?.payload).toMatchObject({ modules: 2, checkPassed: true });
		});
	});

	it("saves a half-finished plan and reports what is missing", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await put(call, s.draft, {
				brief: {
					...APPROVED,
					modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"] }],
				},
				templateRef: null,
				templateVersion: null,
			});
			expect(res.status).toBe(200);
			const plan = one.parse(await res.json()).data;
			expect(plan.check).toEqual({
				passed: false,
				issues: [
					{ path: ["brief", "requirements", 1], message: "R2 is in no module" },
				],
			});
		});
	});

	it("adds requirements and criteria beyond the approved ones", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await put(call, s.draft, {
				brief: {
					...PLANNED,
					requirements: [
						...PLANNED.requirements,
						{ id: "R3", text: "Reminders" },
					],
					acceptanceCriteria: [
						...PLANNED.acceptanceCriteria,
						{ id: "AC3", requirementId: "R3", text: "A reminder is sent" },
					],
					modules: [
						...PLANNED.modules,
						{ id: "M3", name: "Reminders", requirementIds: ["R3"] },
					],
				},
				templateRef: null,
				templateVersion: null,
			});
			expect(res.status).toBe(200);
			expect(one.parse(await res.json()).data.check.passed).toBe(true);
		});
	});

	it("refuses a change to the approved brief, and writes nothing", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await put(call, s.draft, {
				brief: {
					...PLANNED,
					requirements: [
						{ id: "R1", text: "Reworded" },
						PLANNED.requirements[1],
					],
				},
				templateRef: null,
				templateVersion: null,
			});
			const error = await expectReason(res, "plan_changes_approved_brief");
			expect(error.details).toMatchObject({
				issues: [
					{
						path: ["brief", "requirements", 0, "text"],
						message: "R1 was approved and its text cannot change",
					},
				],
			});
			const [row] = await tx
				.select()
				.from(mission)
				.where(eq(mission.id, s.draft));
			expect(row?.brief).toEqual(APPROVED);
			expect(await logRows(s.draft)).toEqual([]);
		});
	});

	it("refuses an approved requirement duplicated with a rewritten copy", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await put(call, s.draft, {
				brief: {
					...PLANNED,
					requirements: [
						...PLANNED.requirements,
						{ id: "R1", text: "REWRITTEN" },
					],
				},
				templateRef: null,
				templateVersion: null,
			});
			await expectReason(res, "plan_changes_approved_brief");
			const [row] = await tx
				.select()
				.from(mission)
				.where(eq(mission.id, s.draft));
			expect(row?.brief).toEqual(APPROVED);
		});
	});

	it("refuses a mission that is not a draft", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			const res = await put(call, s.active, {
				brief: PLANNED,
				templateRef: null,
				templateVersion: null,
			});
			await expectReason(res, "mission_not_editable");
		});
	});

	it("answers 404 for a deleted or unknown mission", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			for (const missionId of [
				s.deleted,
				`${ns}-0000-4000-8000-0000000fffff`,
			]) {
				expect((await call(`/api/missions/${missionId}/plan`)).status).toBe(
					404,
				);
				const res = await put(call, missionId, {
					brief: PLANNED,
					templateRef: null,
					templateVersion: null,
				});
				expect(res.status).toBe(404);
			}
		});
	});

	it("refuses a template ref without a version, and a short sha", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			for (const template of [
				{ templateRef: "template-booking", templateVersion: null },
				{ templateRef: null, templateVersion: SHA },
				{ templateRef: "template-booking", templateVersion: "abc123" },
				{ templateRef: "Template Booking", templateVersion: SHA },
			]) {
				const res = await put(call, s.draft, { brief: PLANNED, ...template });
				expect(res.status).toBe(400);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"VALIDATION_FAILED",
				);
			}
		});
	});

	it("the database refuses a version without a ref", async () => {
		await withApi(async ({ signIn, operatorId, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns, await operatorId());
			await expect(
				tx.transaction((inner) =>
					inner
						.update(mission)
						.set({ templateRef: null, templateVersion: SHA })
						.where(eq(mission.id, s.draft)),
				),
			).rejects.toThrow();
		});
	});
});
