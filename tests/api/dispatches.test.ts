import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	type Brief,
	completionReport as completionReportWire,
	dispatch as dispatchWireSchema,
	errorEnvelope,
	missionDetail,
	pageEnvelope,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	client,
	completionReport,
	dispatch,
	engagement,
	mission,
	rosterEntry,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
	seedAgent,
} from "../db/dispatch-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

const one = successEnvelope(dispatchWireSchema);
const list = pageEnvelope(dispatchWireSchema);
const reports = pageEnvelope(completionReportWire);
const oneReport = successEnvelope(completionReportWire);
const detail = successEnvelope(missionDetail);

const PLANNED: Brief = {
	summary: "Accounts",
	requirements: [
		{ id: "R1", text: "Sign up" },
		{ id: "R2", text: "Sign in" },
	],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Signing up works" },
		{ id: "AC2", requirementId: "R2", text: "Signing in works" },
	],
	modules: [
		{ id: "M6", name: "Accounts", requirementIds: ["R1", "R2"], reads: [] },
	],
	checks: [
		{ id: "CK1", requirementId: "R1", kind: "test", command: "pnpm test R1" },
		{ id: "CK2", requirementId: "R2", kind: "test", command: "pnpm test R2" },
	],
};

/** Ids under the call's namespace, far above the app's own sequence. */
function idsFrom(ns: string, start: number): IdGenerator {
	let n = start;
	return {
		next: () => {
			n += 1;
			return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
		},
	};
}

/** An active client mission with a passing plan and one agent (Kel) on its roster. */
async function seed(tx: Tx, ns: string) {
	const ids = idsFrom(ns, 0xd00);
	const clientId = ids.next();
	await tx.insert(client).values({
		id: clientId,
		name: `Client ${ns}`,
		status: "active",
		...stamp(clock),
	});
	const engagementId = ids.next();
	await tx.insert(engagement).values({
		id: engagementId,
		clientId,
		name: "Accounts",
		status: "active",
		startedAt: clock.now(),
		...stamp(clock),
	});
	const missionId = ids.next();
	await tx.insert(mission).values({
		id: missionId,
		origin: "client",
		engagementId,
		type: `accounts-${ns}`,
		brief: PLANNED,
		sprintN: 1,
		status: "active",
		cut: "horizontal",
		cutSource: "derived",
		repoUrl: "https://github.com/avel-org/app",
		spendCeilingUsd: "40.00",
		...stamp(clock),
	});
	const kel = await seedAgent(tx, ids, missionId);
	await tx
		.update(rosterEntry)
		.set({ estimatedTokens: 10000 })
		.where(eq(rosterEntry.id, kel.entryId));
	return { ids, clientId, engagementId, missionId, kel };
}

type Call = ApiHarness["call"];

const KEY = "11111111-1111-4111-8111-111111111111";

const create = (
	call: Call,
	missionId: string,
	body: object,
	key: string = KEY,
) =>
	call(`/api/missions/${missionId}/dispatches`, {
		method: "POST",
		body,
		headers: { "idempotency-key": key },
	});

const body = (entryId: string, over: object = {}) => ({
	rosterEntryId: entryId,
	briefRef: { moduleId: "M6", requirementIds: ["R1"] },
	...over,
});

async function refusal(res: Response) {
	expect(res.status).toBe(422);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("PRECONDITION_FAILED");
	return error.details as Record<string, unknown>;
}

async function invalid(res: Response) {
	expect(res.status).toBe(400);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("VALIDATION_FAILED");
	return (error.details as { body: Array<{ path: unknown[] }> }).body.map(
		(i) => i.path,
	);
}

describe.skipIf(!process.env.DATABASE_URL)("dispatches", () => {
	afterAll(closeDb);

	it("queues a dispatch from the entry's estimate, with default ceilings, and logs it", async () => {
		await withApi(async ({ signIn, call, tx, ns, operatorId }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await create(call, s.missionId, body(s.kel.entryId));
			expect(res.status).toBe(201);
			expect(res.headers.get("idempotency-replayed")).toBeNull();
			const d = one.parse(await res.json()).data;
			expect(d).toMatchObject({
				missionId: s.missionId,
				rosterEntryId: s.kel.entryId,
				agent: {
					templateId: s.kel.templateId,
					slug: s.kel.slug,
					name: "Kel",
				},
				territory: "accounts",
				briefRef: { moduleId: "M6", requirementIds: ["R1"] },
				status: "queued",
				haltReason: null,
				estimatedTokens: 10000,
				tokenSoftCeiling: 15000,
				tokenHardCeiling: 30000,
				tokensUsed: 0,
				spendUsd: 0,
				wallClockMinutes: 60,
				agentVersionSha256: null,
				agentVersionRef: null,
				model: null,
				reportId: null,
				startedAt: null,
				closedAt: null,
			});
			const [row] = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.entityId, d.id));
			expect(row).toMatchObject({
				actorKind: "operator",
				actorUserId: await operatorId(),
				action: "dispatch.created",
				entityType: "dispatch",
				missionId: s.missionId,
				engagementId: s.engagementId,
				payload: {
					rosterEntryId: s.kel.entryId,
					moduleId: "M6",
					estimatedTokens: 10000,
					tokenSoftCeiling: 15000,
					tokenHardCeiling: 30000,
				},
			});
		});
	});

	it("takes the body's estimate, ceilings and wall clock over the entry's", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(rosterEntry)
				.set({ tokenSoftCeiling: 12000, tokenHardCeiling: 20000 })
				.where(eq(rosterEntry.id, s.kel.entryId));
			const fromEntry = one.parse(
				await (await create(call, s.missionId, body(s.kel.entryId))).json(),
			).data;
			expect(fromEntry).toMatchObject({
				tokenSoftCeiling: 12000,
				tokenHardCeiling: 20000,
			});
			const res = await create(
				call,
				s.missionId,
				body(s.kel.entryId, {
					estimatedTokens: 5000,
					tokenSoftCeiling: 6000,
					tokenHardCeiling: 9000,
					wallClockMinutes: 90,
				}),
				"22222222-2222-4222-8222-222222222222",
			);
			expect(res.status).toBe(201);
			expect(one.parse(await res.json()).data).toMatchObject({
				estimatedTokens: 5000,
				tokenSoftCeiling: 6000,
				tokenHardCeiling: 9000,
				wallClockMinutes: 90,
			});
		});
	});

	it("replays the same key and body, and refuses the same key with another body", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const first = one.parse(
				await (await create(call, s.missionId, body(s.kel.entryId))).json(),
			).data;
			// Same body, keys in another order: the canonical hash is equal.
			const again = await create(call, s.missionId, {
				briefRef: { requirementIds: ["R1"], moduleId: "M6" },
				rosterEntryId: s.kel.entryId,
			});
			expect(again.status).toBe(200);
			expect(again.headers.get("idempotency-replayed")).toBe("true");
			expect(one.parse(await again.json()).data).toEqual(first);

			const other = await create(
				call,
				s.missionId,
				body(s.kel.entryId, { estimatedTokens: 1 }),
			);
			expect(other.status).toBe(409);
			expect(errorEnvelope.parse(await other.json()).error.code).toBe(
				"IDEMPOTENCY_REPLAY",
			);
			const rows = await tx
				.select({ id: dispatch.id })
				.from(dispatch)
				.where(eq(dispatch.missionId, s.missionId));
			expect(rows).toHaveLength(1);
			const logs = await tx
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.missionId, s.missionId),
						eq(activityLog.action, "dispatch.created"),
					),
				);
			expect(logs).toHaveLength(1);
		});
	});

	it("needs an Idempotency-Key", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(`/api/missions/${s.missionId}/dispatches`, {
				method: "POST",
				body: body(s.kel.entryId),
			});
			expect(res.status).toBe(400);
		});
	});

	it("refuses a mission that is not active", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(mission)
				.set({ status: "draft" })
				.where(eq(mission.id, s.missionId));
			expect(
				await refusal(await create(call, s.missionId, body(s.kel.entryId))),
			).toEqual({ reason: "mission_not_active", missionId: s.missionId });
		});
	});

	it("refuses an entry that is not on the mission, deleted, or inactive", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const elsewhere = s.ids.next();
			expect(
				await refusal(await create(call, s.missionId, body(elsewhere))),
			).toEqual({
				reason: "roster_entry_not_found",
				missionId: s.missionId,
				rosterEntryIds: [elsewhere],
			});
			await tx
				.update(rosterEntry)
				.set({ active: false })
				.where(eq(rosterEntry.id, s.kel.entryId));
			expect(
				(await refusal(await create(call, s.missionId, body(s.kel.entryId))))
					.reason,
			).toBe("roster_entry_inactive");
			await tx
				.update(rosterEntry)
				.set({ active: true, deletedAt: clock.now() })
				.where(eq(rosterEntry.id, s.kel.entryId));
			expect(
				(await refusal(await create(call, s.missionId, body(s.kel.entryId))))
					.reason,
			).toBe("roster_entry_not_found");
		});
	});

	it("refuses another mission's entry, as if it did not exist", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const otherMission = s.ids.next();
			await tx.insert(mission).values({
				id: otherMission,
				origin: "internal",
				type: `other-${ns}`,
				brief: PLANNED,
				sprintN: 1,
				status: "active",
				cut: "horizontal",
				cutSource: "derived",
				repoUrl: "https://github.com/avel-org/app",
				...stamp(clock),
			});
			const theirs = await seedAgent(tx, s.ids, otherMission, "Raze");
			await tx
				.update(rosterEntry)
				.set({ estimatedTokens: 10000 })
				.where(eq(rosterEntry.id, theirs.entryId));
			expect(
				await refusal(await create(call, s.missionId, body(theirs.entryId))),
			).toEqual({
				reason: "roster_entry_not_found",
				missionId: s.missionId,
				rosterEntryIds: [theirs.entryId],
			});
		});
	});

	it("refuses an agent with no identity: none generated, or not a model agent", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const templateId = s.ids.next();
			await tx.insert(agentTemplate).values({
				id: templateId,
				slug: `${ns}-bare`,
				name: "Bare",
				kind: "feature",
				roles: ["domain"],
				waveDefaults: ["B"],
				writablePaths: ["src/**"],
				version: 1,
				...stamp(clock),
			});
			const entryId = s.ids.next();
			await tx.insert(rosterEntry).values({
				id: entryId,
				missionId: s.missionId,
				agentTemplateId: templateId,
				active: true,
				waves: ["B"],
				estimatedTokens: 100,
				grain: "default",
				absorbedBoundaries: [],
				...stamp(clock),
			});
			expect(
				(await refusal(await create(call, s.missionId, body(entryId)))).reason,
			).toBe("agent_identity_missing");

			// Kel has identity versions, but foundations is the operator's role.
			await tx
				.update(agentTemplate)
				.set({ roles: ["foundations"] })
				.where(eq(agentTemplate.id, s.kel.templateId));
			expect(
				(await refusal(await create(call, s.missionId, body(s.kel.entryId))))
					.reason,
			).toBe("agent_identity_missing");
		});
	});

	it("refuses a missing estimate, and ceilings below what they bound", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(rosterEntry)
				.set({ estimatedTokens: null })
				.where(eq(rosterEntry.id, s.kel.entryId));
			expect(
				await refusal(await create(call, s.missionId, body(s.kel.entryId))),
			).toMatchObject({
				reason: "estimate_missing",
				rosterEntryIds: [s.kel.entryId],
				issues: [{ path: ["roster", s.kel.entryId, "estimatedTokens"] }],
			});
			expect(
				await invalid(
					await create(
						call,
						s.missionId,
						body(s.kel.entryId, {
							estimatedTokens: 100,
							tokenSoftCeiling: 99,
							tokenHardCeiling: 98,
						}),
					),
				),
			).toEqual([["tokenSoftCeiling"], ["tokenHardCeiling"]]);
		});
	});

	it("refuses a requirement with no check outside the agent", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			// An active mission whose plan predates rule 5: R1 has no check.
			await tx
				.update(mission)
				.set({ brief: { ...PLANNED, checks: PLANNED.checks.slice(1) } })
				.where(eq(mission.id, s.missionId));
			const res = await create(call, s.missionId, body(s.kel.entryId));
			expect(res.status).toBe(422);
			expect(await refusal(res)).toEqual({
				reason: "requirement_unchecked",
				missionId: s.missionId,
				issues: [
					{
						path: ["briefRef", "requirementIds", 0],
						message: "R1 has no check outside the agent",
					},
				],
			});
			const rows = await tx
				.select()
				.from(dispatch)
				.where(eq(dispatch.missionId, s.missionId));
			expect(rows).toEqual([]);
		});
	});

	it("refuses a briefRef the mission's plan does not hold", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			expect(
				await invalid(
					await create(
						call,
						s.missionId,
						body(s.kel.entryId, {
							briefRef: { moduleId: "M9", requirementIds: [] },
						}),
					),
				),
			).toEqual([["briefRef", "moduleId"]]);
			expect(
				await invalid(
					await create(
						call,
						s.missionId,
						body(s.kel.entryId, {
							briefRef: { moduleId: "M6", requirementIds: ["R1", "R7"] },
						}),
					),
				),
			).toEqual([["briefRef", "requirementIds", 1]]);
		});
	});

	it("lists a mission's dispatches newest first, filtered, and gets one", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const queued = await insertDispatchRow(
				tx,
				s.ids,
				dispatchValues(s.kel, s.ids, "queued", { idempotencyKey: "a" }),
			);
			const running = await insertDispatchRow(
				tx,
				s.ids,
				dispatchValues(s.kel, s.ids, "running", { idempotencyKey: "b" }),
			);
			const all = list.parse(
				await (await call(`/api/missions/${s.missionId}/dispatches`)).json(),
			);
			expect(all.data.map((d) => d.id)).toEqual([running, queued]);
			const filtered = list.parse(
				await (
					await call(`/api/missions/${s.missionId}/dispatches?status=queued`)
				).json(),
			);
			expect(filtered.data.map((d) => d.id)).toEqual([queued]);
			const got = await call(`/api/dispatches/${running}`);
			expect(got.status).toBe(200);
			expect(one.parse(await got.json()).data).toMatchObject({
				id: running,
				status: "running",
				agentVersionRef: `${s.kel.slug}@v2`,
			});
		});
	});

	it("lists and gets reports, and puts the mission's spend on its detail", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			expect(
				detail.parse(await (await call(`/api/missions/${s.missionId}`)).json())
					.data.spentUsd,
			).toBe(0);
			const d1 = await insertDispatchRow(
				tx,
				s.ids,
				dispatchValues(s.kel, s.ids, "complete", {
					idempotencyKey: "a",
					spendUsd: "1.100000",
				}),
			);
			await insertDispatchRow(
				tx,
				s.ids,
				dispatchValues(s.kel, s.ids, "running", {
					idempotencyKey: "b",
					spendUsd: "2.200003",
				}),
			);
			const report = reportValues(s.ids, {
				id: d1,
				missionId: s.missionId,
				rosterEntryId: s.kel.entryId,
			});
			await tx.insert(completionReport).values(report);

			expect(
				detail.parse(await (await call(`/api/missions/${s.missionId}`)).json())
					.data.spentUsd,
			).toBe(3.300003);
			const page = reports.parse(
				await (
					await call(`/api/missions/${s.missionId}/completion-reports`)
				).json(),
			);
			expect(page.data.map((r) => r.id)).toEqual([report.id]);
			const got = await call(`/api/completion-reports/${report.id}`);
			expect(got.status).toBe(200);
			expect(oneReport.parse(await got.json()).data.dispatchId).toBe(d1);
			expect(
				one.parse(await (await call(`/api/dispatches/${d1}`)).json()).data
					.reportId,
			).toBe(report.id);
		});
	});

	it("hides every read when the mission's client is deleted", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const d1 = await insertDispatchRow(
				tx,
				s.ids,
				dispatchValues(s.kel, s.ids, "complete", { idempotencyKey: "a" }),
			);
			const report = reportValues(s.ids, {
				id: d1,
				missionId: s.missionId,
				rosterEntryId: s.kel.entryId,
			});
			await tx.insert(completionReport).values(report);
			await tx
				.update(client)
				.set({ deletedAt: clock.now() })
				.where(eq(client.id, s.clientId));
			for (const path of [
				`/api/missions/${s.missionId}/dispatches`,
				`/api/dispatches/${d1}`,
				`/api/missions/${s.missionId}/completion-reports`,
				`/api/completion-reports/${report.id}`,
			]) {
				expect((await call(path)).status, path).toBe(404);
			}
			expect(
				(await create(call, s.missionId, body(s.kel.entryId))).status,
			).toBe(404);
		});
	});

	it("needs a session to create", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const s = await seed(tx, ns);
			expect(
				(await create(call, s.missionId, body(s.kel.entryId))).status,
			).toBe(401);
		});
	});
});
