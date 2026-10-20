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
import type { ClientId } from "../../src/db/client-id";
import {
	activityLog,
	agentTemplate,
	canonSession,
	engagement,
	intake,
	rosterEntry,
	rosterPreset,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import { seedCanonIdentity, sessionValues } from "../db/canon-fixtures";
import { seedIds, seedRosteredAgent } from "./agent-fixtures";
import { clock, withApi } from "./support";

// The three actor wires (GET /api/activity, a mission's recentActivity, a
// preset's applications) come from one resolver. Each kind, Canon included, on each wire,
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
			// Canon acts through a session on an intake of the same engagement.
			const [eng] = await tx
				.select({ clientId: engagement.clientId })
				.from(engagement)
				.where(eq(engagement.id, engagementId));
			const clientId = eng?.clientId as string;
			const intakeId = ids.next();
			await tx.insert(intake).values({
				id: intakeId,
				engagementId,
				status: "draft",
				sourceMd: "# Ask",
				openQuestions: [],
				...stamp(clock),
			});
			const session = sessionValues(
				{
					clientId,
					engagementId,
					intakeId,
					scope: clientId as ClientId,
				},
				userId,
				await seedCanonIdentity(tx),
				{ id: ids.next() },
			);
			await tx.insert(canonSession).values(session);
			const kinds = [
				{ actorKind: "system" as const },
				{ actorKind: "canon" as const, actorCanonSessionId: session.id },
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
					canonSessionId: null,
					display: "AVEL runner",
					agent: null,
				},
				operator: {
					kind: "operator",
					userId,
					rosterEntryId: null,
					canonSessionId: null,
					display: operator.login,
					agent: null,
				},
				agent: {
					kind: "agent",
					userId: null,
					rosterEntryId: agent.entryId,
					canonSessionId: null,
					display: "Kel · accounts",
					agent: {
						templateId: agent.templateId,
						slug: agent.slug,
						name: "Kel",
						territory: "accounts",
					},
				},
				canon: {
					kind: "canon",
					userId: null,
					rosterEntryId: null,
					canonSessionId: session.id,
					display: "Canon",
					agent: null,
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
				expect(actors.length, wire).toBeGreaterThanOrEqual(4);
				for (const a of actors) {
					expect(a.display, wire).not.toBeNull();
					expect(a, `${wire} ${a.kind}`).toEqual(expected[a.kind]);
				}
				expect(new Set(actors.map((a) => a.kind)), wire).toEqual(
					new Set(["system", "operator", "agent", "canon"]),
				);
			}
		});
	});
});
