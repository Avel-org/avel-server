import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	finding as findingWire,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { finding } from "../../src/db/schema";
import { requestSha256 } from "../../src/lib/canonical";
import {
	bearer,
	dispatchWithToken,
	seedIds,
	seedRosteredAgent,
} from "./agent-fixtures";
import { clock, withApi } from "./support";

const created = successEnvelope(findingWire);
const FINDINGS = "/api/agent/findings";

const body = {
	rule: "auth.missing-check",
	subject: "src/routes/clients.ts",
	severity: "high",
	class: "authorization",
} as const;

const key = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function failure(res: Response, status: number) {
	expect(res.status).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

/** A judge on a mission, running, with its token. */
async function judge(h: {
	tx: Parameters<typeof seedRosteredAgent>[0];
	ns: string;
}) {
	const ids = seedIds(h.ns);
	const seeded = await seedRosteredAgent(h.tx, ids, ["security-review"]);
	const run = await dispatchWithToken(h.tx, ids, seeded.agent, "running");
	const rows = () =>
		h.tx.select().from(finding).where(eq(finding.missionId, seeded.missionId));
	return { ...seeded, ids, run, rows };
}

describe.skipIf(!process.env.DATABASE_URL)("POST /api/agent/findings", () => {
	afterAll(closeDb);

	it("files an open finding on the dispatch's own mission (201), and logs it as the agent", async () => {
		await withApi(async ({ call, tx, ns, logRows }) => {
			const j = await judge({ tx, ns });
			const res = await call(FINDINGS, {
				method: "POST",
				body,
				headers: { ...bearer(j.run.token), "idempotency-key": key(1) },
			});
			expect(res.status).toBe(201);
			expect(res.headers.get("idempotency-replayed")).toBeNull();
			const wire = created.parse(await res.json()).data;
			expect(wire).toEqual({
				id: expect.any(String),
				missionId: j.missionId,
				clientId: j.clientId,
				...body,
				status: "open",
				dismissedReason: null,
				caughtBy: j.agent.slug,
				reportedByDispatchId: j.run.id,
				createdAt: clock.now().toISOString(),
				updatedAt: clock.now().toISOString(),
			});

			const [row] = await j.rows();
			expect(row).toMatchObject({
				id: wire.id,
				idempotencyKey: key(1),
				requestSha256: requestSha256(body),
			});

			const logs = await logRows(wire.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				actorKind: "agent",
				actorUserId: null,
				actorRosterEntryId: j.agent.entryId,
				action: "finding.opened",
				entityType: "finding",
				entityId: wire.id,
				missionId: j.missionId,
				engagementId: j.engagementId,
				requestId: res.headers.get("x-request-id"),
			});
			// Exactly these keys: toMatchObject above would accept extras.
			expect(logs[0]?.payload).toEqual({
				severity: "high",
				rule: body.rule,
				dispatchId: j.run.id,
			});
		});
	});

	it("accepts a body naming its own mission and dispatch", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const j = await judge({ tx, ns });
			const res = await call(FINDINGS, {
				method: "POST",
				body: { ...body, missionId: j.missionId, dispatchId: j.run.id },
				headers: { ...bearer(j.run.token), "idempotency-key": key(1) },
			});
			expect(res.status).toBe(201);
			expect(await j.rows()).toHaveLength(1);
		});
	});

	it("refuses a body naming another mission or dispatch (422 report_dispatch_mismatch), writing nothing", async () => {
		await withApi(async ({ call, tx, ns, logRows }) => {
			const j = await judge({ tx, ns });
			// A real second dispatch and mission, so the refusal is not a FK miss.
			const other = await seedRosteredAgent(tx, j.ids, ["security-review"]);
			const otherRun = await dispatchWithToken(
				tx,
				j.ids,
				other.agent,
				"running",
			);
			for (const [n, named] of [
				{ missionId: other.missionId },
				{ dispatchId: otherRun.id },
				{ missionId: j.missionId, dispatchId: otherRun.id },
				{ missionId: other.missionId, dispatchId: j.run.id },
			].entries()) {
				const error = await failure(
					await call(FINDINGS, {
						method: "POST",
						body: { ...body, ...named },
						headers: { ...bearer(j.run.token), "idempotency-key": key(n + 1) },
					}),
					422,
				);
				expect(error.code).toBe("PRECONDITION_FAILED");
				expect(error.details).toEqual({ reason: "report_dispatch_mismatch" });
			}
			expect(await j.rows()).toEqual([]);
			expect(
				await tx
					.select()
					.from(finding)
					.where(eq(finding.missionId, other.missionId)),
			).toEqual([]);
			expect(await logRows(j.run.id)).toEqual([]);
		});
	});

	it("replays the same key and body (200, Idempotency-Replayed), whatever the key order", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const j = await judge({ tx, ns });
			const headers = { ...bearer(j.run.token), "idempotency-key": key(1) };
			const first = created.parse(
				await (await call(FINDINGS, { method: "POST", body, headers })).json(),
			).data;
			const reordered = {
				class: body.class,
				severity: body.severity,
				subject: body.subject,
				rule: body.rule,
			};
			const res = await call(FINDINGS, {
				method: "POST",
				body: reordered,
				headers,
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("idempotency-replayed")).toBe("true");
			expect(created.parse(await res.json()).data).toEqual(first);
			expect(await j.rows()).toHaveLength(1);
		});
	});

	it("refuses the same key with a different body (409 IDEMPOTENCY_REPLAY), and logs once", async () => {
		await withApi(async ({ call, tx, ns, logRows }) => {
			const j = await judge({ tx, ns });
			const headers = { ...bearer(j.run.token), "idempotency-key": key(1) };
			const first = created.parse(
				await (await call(FINDINGS, { method: "POST", body, headers })).json(),
			).data;
			const error = await failure(
				await call(FINDINGS, {
					method: "POST",
					body: { ...body, severity: "low" },
					headers,
				}),
				409,
			);
			expect(error.code).toBe("IDEMPOTENCY_REPLAY");
			const rows = await j.rows();
			expect(rows.map((r) => [r.id, r.severity])).toEqual([[first.id, "high"]]);
			expect(await logRows(first.id)).toHaveLength(1);
		});
	});

	it("keeps keys per dispatch: another run's key files its own finding", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const j = await judge({ tx, ns });
			const second = await dispatchWithToken(tx, j.ids, j.agent, "running");
			for (const run of [j.run, second]) {
				const res = await call(FINDINGS, {
					method: "POST",
					body,
					headers: { ...bearer(run.token), "idempotency-key": key(1) },
				});
				expect(res.status).toBe(201);
			}
			const rows = await j.rows();
			expect(rows.map((r) => r.reportedByDispatchId).sort()).toEqual(
				[j.run.id, second.id].sort(),
			);
		});
	});

	it("files a new finding under a new key", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const j = await judge({ tx, ns });
			for (const n of [1, 2]) {
				const res = await call(FINDINGS, {
					method: "POST",
					body,
					headers: { ...bearer(j.run.token), "idempotency-key": key(n) },
				});
				expect(res.status).toBe(201);
			}
			expect(await j.rows()).toHaveLength(2);
		});
	});

	it("answers 400 without a valid key or body, writing nothing", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const j = await judge({ tx, ns });
			for (const [sent, headers] of [
				[body, bearer(j.run.token)],
				[body, { ...bearer(j.run.token), "idempotency-key": "not-a-uuid" }],
				[
					{ ...body, severity: "urgent" },
					{ ...bearer(j.run.token), "idempotency-key": key(1) },
				],
				[
					{ ...body, caughtBy: "someone-else" },
					{ ...bearer(j.run.token), "idempotency-key": key(1) },
				],
				[
					{ ...body, rule: "   " },
					{ ...bearer(j.run.token), "idempotency-key": key(1) },
				],
			] as const) {
				const error = await failure(
					await call(FINDINGS, { method: "POST", body: sent, headers }),
					400,
				);
				expect(error.code).toBe("VALIDATION_FAILED");
			}
			expect(await j.rows()).toEqual([]);
		});
	});

	it("refuses a judge whose dispatch has stopped (401), writing nothing", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const j = await judge({ tx, ns });
			const ended = await dispatchWithToken(tx, j.ids, j.agent, "complete");
			const error = await failure(
				await call(FINDINGS, {
					method: "POST",
					body,
					headers: { ...bearer(ended.token), "idempotency-key": key(1) },
				}),
				401,
			);
			expect(error.code).toBe("DISPATCH_CLOSED");
			expect(await j.rows()).toEqual([]);
		});
	});
});
