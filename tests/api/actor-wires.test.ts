import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	activityListEnvelope,
	missionDetail,
	pageEnvelope,
	presetApplicationSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	rosterEntry,
	rosterPreset,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import { seedIds, seedRosteredAgent } from "./agent-fixtures";
import { clock, withApi } from "./support";

// The three actor wires (GET /api/activity, a mission's recentActivity, a
// preset's applications) come from one resolver. Each kind, on each wire,
// with the agent's entry and template removed after it acted.

const at = (s: number) => new Date(clock.now().getTime() - s * 1000);

describe.skipIf(!process.env.DATABASE_URL)("the actor wires", () => {
	afterAll(closeDb);

	it("resolve every kind the same way, never a null display, and an agent after its entry and template are removed", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns, operator }) => {
			await signIn();
			const userId = await operatorId();
			const ids = seedIds(ns);
			const { missionId, engagementId, agent } = await seedRosteredAgent(
				tx,
				ids,
				["domain"],
			);
			const presetId = ids.next();
			await tx.insert(rosterPreset).values({
				id: presetId,
				name: `Preset ${ns}`,
				description: null,
				cut: "vertical",
				agents: [],
				version: 1,
				...stamp(clock),
			});
			const kinds = [
				{ actorKind: "system" as const },
				{ actorKind: "operator" as const, actorUserId: userId },
				{ actorKind: "agent" as const, actorRosterEntryId: agent.entryId },
			];
			for (const [i, actor] of kinds.entries()) {
				await tx.insert(activityLog).values({
					id: ids.next(),
					at: at(10 + i),
					...actor,
					action: "mission.status_changed",
					entityType: "mission",
					entityId: missionId,
					missionId,
					engagementId,
					requestId: `req-${i}`,
					payload: {},
				});
				await tx.insert(activityLog).values({
					id: ids.next(),
					at: at(i),
					...actor,
					action: "roster.preset_applied",
					entityType: "mission",
					entityId: missionId,
					missionId,
					engagementId,
					requestId: `req-p${i}`,
					payload: { presetId, presetVersion: 1, added: [], removed: [] },
				});
			}
			// The agent leaves, and its template goes: its rows still name it.
			await tx
				.update(rosterEntry)
				.set(remove(clock))
				.where(eq(rosterEntry.id, agent.entryId));
			await tx
				.update(agentTemplate)
				.set(remove(clock))
				.where(eq(agentTemplate.id, agent.templateId));

			const expected = {
				system: {
					kind: "system",
					userId: null,
					rosterEntryId: null,
					display: "AVEL runner",
					agent: null,
				},
				operator: {
					kind: "operator",
					userId,
					rosterEntryId: null,
					display: operator.login,
					agent: null,
				},
				agent: {
					kind: "agent",
					userId: null,
					rosterEntryId: agent.entryId,
					display: "Kel · accounts",
					agent: {
						templateId: agent.templateId,
						slug: agent.slug,
						name: "Kel",
						territory: "accounts",
					},
				},
			};

			const feed = activityListEnvelope.parse(
				await (await call(`/api/activity?missionId=${missionId}`)).json(),
			).data;
			const detail = successEnvelope(missionDetail).parse(
				await (await call(`/api/missions/${missionId}`)).json(),
			).data.recentActivity;
			const applied = pageEnvelope(presetApplicationSchema).parse(
				await (await call(`/api/presets/${presetId}/applications`)).json(),
			).data;

			for (const [wire, actors] of [
				["activity", feed.map((r) => r.actor)],
				["mission", detail.map((r) => r.actor)],
				["preset", applied.map((r) => r.actor)],
			] as const) {
				expect(actors.length, wire).toBeGreaterThanOrEqual(3);
				for (const a of actors) {
					expect(a.display, wire).not.toBeNull();
					expect(a, `${wire} ${a.kind}`).toEqual(expected[a.kind]);
				}
				expect(new Set(actors.map((a) => a.kind)), wire).toEqual(
					new Set(["system", "operator", "agent"]),
				);
			}
		});
	});
});
