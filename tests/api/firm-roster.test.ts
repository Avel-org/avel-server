import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import { preconditionDetails } from "../../src/contract/shared/errors";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	dispatch,
	mission,
	rosterEntry,
} from "../../src/db/schema";
import { dispatchValues, insertDispatchRow } from "../db/dispatch-fixtures";
import { seedIds } from "./agent-fixtures";
import { activeMission, queued, start } from "./runner-fixtures";
import { withApi } from "./support";

// Firm roles (FIRM_ROLES) never sit on a mission roster. Adding a Firm
// template to a roster is refused in src/routes/roster.ts; these are the
// other ways in: editing a rostered template, and a race with that edit,
// caught again at mission start (mission-lifecycle.test.ts) and here at
// dispatch create and start.

async function refusal(res: Response) {
	expect(res.status).toBe(422);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("PRECONDITION_FAILED");
	return preconditionDetails.parse(error.details);
}

describe.skipIf(!process.env.DATABASE_URL)(
	"Firm roles stay off rosters",
	() => {
		afterAll(closeDb);

		const patch = (
			call: (p: string, i?: object) => Promise<Response>,
			id: string,
			roles: string[],
		) =>
			call(`/api/agent-templates/${id}`, { method: "PATCH", body: { roles } });

		const templateRow = async (
			tx: Parameters<typeof activeMission>[0],
			id: string,
		) => {
			const [t] = await tx
				.select({ roles: agentTemplate.roles, version: agentTemplate.version })
				.from(agentTemplate)
				.where(eq(agentTemplate.id, id));
			return t;
		};

		it("refuses an edit that gives a rostered template a Firm role, and writes nothing", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const m = await activeMission(tx, seedIds(ns));
				const before = await templateRow(tx, m.agent.templateId);
				for (const roles of [
					["strategy"],
					["intake"],
					["research", "client-ops"],
				]) {
					const d = await refusal(await patch(call, m.agent.templateId, roles));
					expect(d).toEqual({
						reason: "template_not_rosterable",
						missionId: m.missionId,
						rosterEntryIds: [m.agent.entryId],
					});
				}
				expect(await templateRow(tx, m.agent.templateId)).toEqual(before);
				expect(
					await tx
						.select()
						.from(activityLog)
						.where(
							and(
								eq(activityLog.entityId, m.agent.templateId),
								eq(activityLog.action, "agent_template.updated"),
							),
						),
				).toEqual([]);
			});
		});

		it("allows the same edit once the template's only mission has shipped, and a non-Firm edit any time", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const m = await activeMission(tx, seedIds(ns));
				expect((await patch(call, m.agent.templateId, ["domain"])).status).toBe(
					200,
				);
				await tx
					.update(mission)
					.set({ status: "shipped" })
					.where(eq(mission.id, m.missionId));
				expect(
					(await patch(call, m.agent.templateId, ["strategy"])).status,
				).toBe(200);
				expect((await templateRow(tx, m.agent.templateId))?.roles).toEqual([
					"strategy",
				]);
			});
		});

		it("refuses to queue a dispatch of a template that holds a Firm role", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const m = await activeMission(tx, seedIds(ns));
				await tx
					.update(rosterEntry)
					.set({ estimatedTokens: 10000 })
					.where(eq(rosterEntry.id, m.agent.entryId));
				await tx
					.update(agentTemplate)
					.set({ roles: ["strategy"] })
					.where(eq(agentTemplate.id, m.agent.templateId));
				const res = await call(`/api/missions/${m.missionId}/dispatches`, {
					method: "POST",
					headers: {
						"idempotency-key": "11111111-1111-4111-8111-111111111111",
					},
					body: {
						rosterEntryId: m.agent.entryId,
						briefRef: { moduleId: "M6", requirementIds: ["R1"] },
					},
				});
				expect(await refusal(res)).toEqual({
					reason: "template_not_rosterable",
					missionId: m.missionId,
					rosterEntryIds: [m.agent.entryId],
				});
				expect(
					await tx
						.select()
						.from(dispatch)
						.where(eq(dispatch.missionId, m.missionId)),
				).toEqual([]);
			});
		});

		it("refuses to start a queued dispatch whose template now holds a Firm role", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const id = await queued(h.tx, m);
				await h.tx
					.update(agentTemplate)
					.set({ roles: ["strategy"] })
					.where(eq(agentTemplate.id, m.agent.templateId));
				expect(await refusal(await start(h, id))).toEqual({
					reason: "template_not_rosterable",
					dispatchId: id,
					missionId: m.missionId,
					rosterEntryIds: [m.agent.entryId],
				});
				const [d] = await h.tx
					.select({ status: dispatch.status, startedAt: dispatch.startedAt })
					.from(dispatch)
					.where(eq(dispatch.id, id));
				expect(d).toEqual({ status: "queued", startedAt: null });
				expect(
					await h.tx
						.select()
						.from(activityLog)
						.where(eq(activityLog.entityId, id)),
				).toEqual([]);
			});
		});

		it("leaves a closed dispatch to the runner's own refusal, Firm role or not", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const id = await insertDispatchRow(
					h.tx,
					m.ids,
					dispatchValues(m.agent, m.ids, "halted"),
				);
				await h.tx
					.update(agentTemplate)
					.set({ roles: ["strategy"] })
					.where(eq(agentTemplate.id, m.agent.templateId));
				expect((await refusal(await start(h, id))).reason).toBe(
					"dispatch_not_queued",
				);
			});
		});
	},
);
