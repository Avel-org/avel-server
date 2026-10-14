import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	DISPATCH_STATUSES,
	errorEnvelope,
	templateDispatchListEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import type { NewDispatch } from "../../src/db/dispatch";
import {
	agentTemplate,
	client,
	completionReport,
	mission,
	rosterEntry,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
	type SeededAgent,
} from "../db/dispatch-fixtures";
import { seedMission } from "../db/fixtures";
import { seedIds, seedRosteredAgent } from "./agent-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

const envelope = templateDispatchListEnvelope;

/** The template's entry on another mission: same template, its own entry. */
async function entryOn(
	tx: Tx,
	ids: IdGenerator,
	agent: SeededAgent,
	missionId: string,
): Promise<SeededAgent> {
	const entryId = ids.next();
	await tx.insert(rosterEntry).values({
		id: entryId,
		missionId,
		agentTemplateId: agent.templateId,
		active: true,
		waves: ["B"],
		territory: "billing",
		grain: "default",
		absorbedBoundaries: [],
		...stamp(clock),
	});
	return { ...agent, missionId, entryId };
}

async function run(
	tx: Tx,
	ids: IdGenerator,
	agent: SeededAgent,
	status: Parameters<typeof dispatchValues>[2],
	over: Partial<NewDispatch> = {},
): Promise<string> {
	return insertDispatchRow(tx, ids, dispatchValues(agent, ids, status, over));
}

/**
 * Template T on four missions: two shown (one client, one internal), one
 * deleted, and one whose client is deleted. Another template's dispatch
 * on the shown mission. Spend is chosen so a float sum would be off.
 */
async function world(h: ApiHarness) {
	const ids = seedIds(h.ns);
	const { missionId, clientId, agent } = await seedRosteredAgent(h.tx, ids, [
		"domain",
	]);
	const internal = (await seedMission(h.tx, ids)).missionId;
	await h.tx
		.update(mission)
		.set({ origin: "internal", engagementId: null })
		.where(eq(mission.id, internal));
	const onInternal = await entryOn(h.tx, ids, agent, internal);
	const deleted = (await seedMission(h.tx, ids)).missionId;
	const onDeleted = await entryOn(h.tx, ids, agent, deleted);
	await h.tx.update(mission).set(remove(clock)).where(eq(mission.id, deleted));
	const orphaned = await seedMission(h.tx, ids);
	const onOrphaned = await entryOn(h.tx, ids, agent, orphaned.missionId);
	await h.tx
		.update(client)
		.set(remove(clock))
		.where(eq(client.id, orphaned.clientId));

	const d = {
		queued: await run(h.tx, ids, agent, "queued"),
		running: await run(h.tx, ids, agent, "running", {
			spendUsd: "1234.100001",
		}),
		complete: await run(h.tx, ids, agent, "complete", {
			spendUsd: "2345.200002",
		}),
		halted: await run(h.tx, ids, agent, "halted", {
			spendUsd: "3456.300003",
		}),
		internalFailed: await run(h.tx, ids, onInternal, "failed", {
			spendUsd: "4567.400004",
		}),
		hiddenDeleted: await run(h.tx, ids, onDeleted, "failed", {
			spendUsd: "100",
		}),
		hiddenOrphaned: await run(h.tx, ids, onOrphaned, "complete", {
			spendUsd: "100",
		}),
	};
	await h.tx.insert(completionReport).values(
		reportValues(ids, {
			id: d.complete,
			missionId,
			rosterEntryId: agent.entryId,
		}),
	);
	// Another template on the shown mission: never this template's.
	const other = await seedRosteredAgent(h.tx, ids, ["domain"]);
	await run(h.tx, ids, other.agent, "failed", { spendUsd: "50" });
	return { ids, agent, missionId, clientId, internal, d };
}

const list = async (h: ApiHarness, templateId: string, query = "") => {
	const res = await h.call(
		`/api/agent-templates/${templateId}/dispatches${query}`,
	);
	expect(res.status).toBe(200);
	return envelope.parse(await res.json());
};

describe.skipIf(!process.env.DATABASE_URL)(
	"GET /api/agent-templates/:id/dispatches",
	() => {
		afterAll(closeDb);

		it("lists the template's dispatches on shown missions, newest first, with mission and report", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const w = await world(h);
				const { data, meta } = await list(h, w.agent.templateId);
				// Same created_at, so id desc: the later dispatch first.
				expect(data.map((r) => r.id)).toEqual([
					w.d.internalFailed,
					w.d.halted,
					w.d.complete,
					w.d.running,
					w.d.queued,
				]);
				const complete = data.find((r) => r.id === w.d.complete);
				expect(complete?.mission).toEqual({
					id: w.missionId,
					type: "full-build",
					sprintN: 1,
					status: "draft",
					origin: "client",
					client: { id: w.clientId, name: "Meridian" },
				});
				expect(complete?.report).toEqual({
					id: complete?.reportId,
					status: "complete",
					filedBy: "agent",
					actualTokens: 100,
					blockers: 1,
					edgeMismatches: 1,
				});
				expect(complete?.reportId).not.toBeNull();
				const internal = data.find((r) => r.id === w.d.internalFailed);
				expect(internal?.mission).toMatchObject({
					id: w.internal,
					origin: "internal",
					client: null,
				});
				expect(internal?.territory).toBe("billing");
				for (const r of data.filter((x) => x.id !== w.d.complete)) {
					expect(r.report, r.status).toBeNull();
				}
				expect(meta.nextCursor).toBeNull();
				expect(meta.total).toBe(5);
			});
		});

		it("totals what the filters keep: zero-filled statuses, exact numeric spend, token sums", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const w = await world(h);
				const { meta } = await list(h, w.agent.templateId);
				expect(Object.keys(meta.totals.byStatus).sort()).toEqual(
					[...DISPATCH_STATUSES].sort(),
				);
				expect(meta.totals).toEqual({
					total: 5,
					byStatus: {
						queued: 1,
						running: 1,
						complete: 1,
						blocked: 0,
						failed: 1,
						halted: 1,
					},
					// Summed as numeric: exact to the sixth place, where a float sum is not.
					spendUsd: 11603.00001,
					tokensUsed: 400,
					estimatedTokens: 5000,
				});
			});
		});

		it("filters by status and mission, rows and totals alike", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const w = await world(h);
				const failed = await list(h, w.agent.templateId, "?status=failed");
				expect(failed.data.map((r) => r.id)).toEqual([w.d.internalFailed]);
				expect(failed.meta.totals).toMatchObject({
					total: 1,
					byStatus: { failed: 1, complete: 0 },
					spendUsd: 4567.400004,
				});
				const onMission = await list(
					h,
					w.agent.templateId,
					`?missionId=${w.missionId}`,
				);
				expect(onMission.data.map((r) => r.id)).toEqual([
					w.d.halted,
					w.d.complete,
					w.d.running,
					w.d.queued,
				]);
				expect(onMission.meta.totals.total).toBe(4);
				expect(onMission.meta.totals.spendUsd).toBe(7035.600006);
				const both = await list(
					h,
					w.agent.templateId,
					`?missionId=${w.missionId}&status=failed`,
				);
				expect(both.data).toEqual([]);
				expect(both.meta.totals.total).toBe(0);
				expect(both.meta.totals.spendUsd).toBe(0);
			});
		});

		it("pages with a cursor while the totals stay whole", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const w = await world(h);
				const first = await list(h, w.agent.templateId, "?limit=2");
				expect(first.data).toHaveLength(2);
				expect(first.meta.nextCursor).not.toBeNull();
				const second = await list(
					h,
					w.agent.templateId,
					`?limit=2&cursor=${first.meta.nextCursor}`,
				);
				expect(second.data.map((r) => r.id)).toEqual([
					w.d.complete,
					w.d.running,
				]);
				expect(second.meta.totals).toEqual(first.meta.totals);
				expect(second.meta.totals.total).toBe(5);
			});
		});

		it("keeps a removed roster entry's dispatches", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const w = await world(h);
				await h.tx
					.update(rosterEntry)
					.set(remove(clock))
					.where(eq(rosterEntry.id, w.agent.entryId));
				const { meta } = await list(h, w.agent.templateId);
				expect(meta.totals.total).toBe(5);
			});
		});

		it("answers 404 for an unknown or deleted template", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const w = await world(h);
				const unknown = await h.call(
					"/api/agent-templates/00000000-0000-4000-8000-00000000ffff/dispatches",
				);
				expect(unknown.status).toBe(404);
				await h.tx
					.update(agentTemplate)
					.set(remove(clock))
					.where(eq(agentTemplate.id, w.agent.templateId));
				const gone = await h.call(
					`/api/agent-templates/${w.agent.templateId}/dispatches`,
				);
				expect(gone.status).toBe(404);
				expect(errorEnvelope.parse(await gone.json()).error.code).toBe(
					"NOT_FOUND",
				);
			});
		});
	},
);
