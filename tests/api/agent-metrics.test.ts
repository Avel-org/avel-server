import { afterAll, describe, expect, it } from "vitest";
import { agentMetricsSchema, successEnvelope } from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { activityLog, completionReport } from "../../src/db/schema";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
} from "../db/dispatch-fixtures";
import { activeMission, runnerIds } from "./runner-fixtures";
import { withApi } from "./support";

// Module 12's agent measurements (ROSTER-V2.md, DATA-CONTRACTS-V2.md):
// discipline across the name, outcome per territory, template and
// engagement, and internal and client work never combined.

describe.skipIf(!process.env.DATABASE_URL)(
	"GET /api/agent-templates/:id/metrics",
	() => {
		afterAll(closeDb);

		it("counts recorded reports only, by origin, with the first and latest gate runs read for their own measures", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const ids = runnerIds(h.ns);
				const m = await activeMission(h.tx, ids);
				const agent = m.agent;
				const closed = async (
					status: "complete" | "blocked",
					over: Partial<typeof completionReport.$inferInsert>,
				) => {
					const id = await insertDispatchRow(
						h.tx,
						ids,
						dispatchValues(agent, ids, status, { spendUsd: "0.25" }),
					);
					await h.tx
						.insert(completionReport)
						.values(
							reportValues(
								ids,
								{ id, missionId: m.missionId, rosterEntryId: agent.entryId },
								{ status, ...over },
							),
						);
					return id;
				};
				// One blocker and one edge mismatch each, by the fixture.
				const first = await closed("complete", {});
				await closed("blocked", {});
				// Reconstructed: for findings only, never counted.
				await closed("complete", { versionSource: "reconstructed" });

				const run = (result: "fail" | "verified", at: string) => ({
					id: ids.next(),
					at: new Date(at),
					actorKind: "system" as const,
					action: "mission.gate_run" as const,
					entityType: "mission" as const,
					entityId: m.missionId,
					missionId: m.missionId,
					requestId: "test",
					payload: {
						result,
						receipt: JSON.stringify({
							findings: [
								{
									id: `checkpoint:test-glob:${first}:tests/a.test.ts`,
									kind: "checkpoint",
									outcome: "fail",
								},
							],
						}),
					},
				});
				await h.tx
					.insert(activityLog)
					.values([
						run("fail", "2026-10-05T10:00:00.000Z"),
						run("verified", "2026-10-05T11:00:00.000Z"),
					]);

				const get = async (q: string) => {
					const res = await h.call(
						`/api/agent-templates/${agent.templateId}/metrics${q}`,
					);
					expect(res.status, await res.clone().text()).toBe(200);
					return successEnvelope(agentMetricsSchema).parse(await res.json())
						.data;
				};
				const internal = await get("?origin=internal");
				expect(internal.discipline).toEqual({
					dispatches: 2,
					blockersFiled: 2,
					blockedReports: 1,
					edgeMismatches: 2,
					testFileWritesCaught: 1,
					notRecorded: ["boundary_violations", "blockers_absorbed"],
				});
				expect(internal.outcome).toEqual([
					{
						territory: "accounts",
						templateRef: "template-booking",
						engagementId: null,
						dispatches: 2,
						tokensUsed: 200,
						spendUsd: 0.5,
						wallClockMinutes: 120,
						missionsGated: 1,
						// The first run failed; the later verified run does not make it a first pass.
						firstPassVerified: 0,
					},
				]);

				// Client work is never combined with internal work.
				const client = await get("?origin=client");
				expect(client.discipline.dispatches).toBe(0);
				expect(client.outcome).toEqual([]);

				const noOrigin = await h.call(
					`/api/agent-templates/${agent.templateId}/metrics`,
				);
				expect(noOrigin.status).toBe(400);
				const missing = await h.call(
					`/api/agent-templates/${ids.next()}/metrics?origin=internal`,
				);
				expect(missing.status).toBe(404);
			});
		});
	},
);
