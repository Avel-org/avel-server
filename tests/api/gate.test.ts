import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	errorEnvelope,
	gateRunListEnvelope,
	gateRun as gateRunSchema,
	preconditionDetails,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	completionReport,
	mission,
	playbook,
	rosterPreset,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { worktreeRooms } from "../../src/rooms/provider";
import { snapshotDispatch } from "../../src/rooms/snapshot";
import type { RoomSourceResolver } from "../../src/rooms/sources";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
} from "../db/dispatch-fixtures";
import { makeRepo, removeDir, tempDir, writeFiles } from "../unit/git-fixtures";
import { activeMission, type Mission, runnerIds } from "./runner-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

// POST /api/missions/:id/gate and its reads (module 9, decided 2026-10-19):
// the mission's complete dispatches integrated onto its pinned commit,
// judged by decide(), recorded with its receipt in the activity log.

vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("gate");
afterAll(async () => {
	removeDir(base);
	await closeDb();
});

const FILES = {
	"src/a.ts": "export const a = 1;\n",
	"package.json": '{ "name": "salon", "scripts": { "test": "vitest run" } }\n',
};

let n = 0;

/** A repository at its pinned commit, and a source resolver that finds it. */
function repo() {
	const dir = path.join(base, `repo-${++n}`);
	const [pinned] = makeRepo(dir, FILES) as [string];
	const rooms = worktreeRooms(path.join(base, `rooms-${n}`));
	const roomSources: RoomSourceResolver = {
		resolve: async () => ({ ok: true, repoPath: dir, commit: pinned }),
	};
	return { dir, pinned, rooms, roomSources };
}

type Repo = ReturnType<typeof repo>;

async function pinTo(tx: Tx, m: Mission, sha: string) {
	await tx
		.update(mission)
		.set({ templateVersion: sha })
		.where(eq(mission.id, m.missionId));
}

/** A dispatch that closed with `status`, its room's bytes committed when it has files. */
async function closedDispatch(
	h: ApiHarness,
	m: Mission,
	r: Repo,
	files: Record<string, string> | null,
	status: "complete" | "blocked" = "complete",
) {
	const id = await insertDispatchRow(
		h.tx,
		m.ids,
		dispatchValues(m.agent, m.ids, "complete"),
	);
	let resultCommitSha: string | null = null;
	if (files) {
		const room = await r.rooms.open({
			dispatchId: id,
			repoPath: r.dir,
			commit: r.pinned,
			writableGlobs: ["**"],
		});
		writeFiles(room.root, files);
		resultCommitSha = await snapshotDispatch(
			room,
			r.pinned,
			id,
			clock.now().toISOString(),
		);
	}
	await h.tx
		.insert(completionReport)
		.values(
			reportValues(
				m.ids,
				{ id, missionId: m.missionId, rosterEntryId: m.agent.entryId },
				{ status, resultCommitSha },
			),
		);
	return id;
}

const run = (
	h: ApiHarness,
	missionId: string,
	body: unknown = {},
	key?: string,
) =>
	h.call(`/api/missions/${missionId}/gate`, {
		method: "POST",
		body,
		headers: key ? { "idempotency-key": key } : {},
	});

async function refusal(res: Response) {
	expect(res.status, await res.clone().text()).toBe(422);
	return preconditionDetails.parse(
		errorEnvelope.parse(await res.json()).error.details,
	);
}

async function gated(
	r: Repo,
	fn: (h: ApiHarness, m: Mission) => Promise<void>,
) {
	return withApi(
		async (h) => {
			await h.signIn();
			const m = await activeMission(h.tx, runnerIds(h.ns));
			await pinTo(h.tx, m, r.pinned);
			await fn(h, m);
		},
		{ roomSources: r.roomSources },
	);
}

describe.skipIf(!process.env.DATABASE_URL)("/api gate", () => {
	it("judges the integration commit of the complete dispatches, records the run, and serves it back", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			// A playbook that makes acceptance mandatory, so the plan's checks count.
			const type = `gate-${h.ns}`;
			const presetId = m.ids.next();
			await h.tx.insert(rosterPreset).values({
				id: presetId,
				name: `Preset ${h.ns}`,
				description: null,
				cut: "vertical",
				agents: [],
				version: 1,
				...stamp(clock),
			});
			await h.tx.insert(playbook).values({
				id: m.ids.next(),
				missionType: type,
				name: "Gate test",
				wavesApplicable: ["A"],
				gates: [{ gate: "acceptance", policy: "mandatory" }],
				deliverable: "pr",
				requiredFields: [],
				defaultPresetId: presetId,
				version: 1,
				...stamp(clock),
			});
			await h.tx
				.update(mission)
				.set({ type })
				.where(eq(mission.id, m.missionId));
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			await closedDispatch(h, m, r, { "src/c.ts": "export const c = 3;\n" });

			const res = await run(h, m.missionId);
			expect(res.status, await res.clone().text()).toBe(201);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			expect(posted.baseSha).toBe(r.pinned);
			expect(posted.commitSha).toMatch(/^[0-9a-f]{40}$/);
			expect(posted.commitSha).not.toBe(r.pinned);
			expect(posted.receiptSha256).toBe(
				createHash("sha256").update(posted.receipt, "utf8").digest("hex"),
			);
			expect(posted.verdict).toBe("pass");
			// The plan's test checks have no runner yet: degraded warns, never passes.
			const degraded = posted.reasons.filter((x) => x.degraded);
			expect(degraded.length).toBeGreaterThan(0);
			for (const x of degraded) expect(x.effect).toBe("warn");
			// So the pass is not a verified one, and the run says so.
			expect(posted.assurance).toBe("not_fully_checked");
			expect([posted.decideVersion, posted.receiptVersion]).toEqual([2, 2]);
			const receipt = JSON.parse(posted.receipt);
			expect(receipt.assurance).toBe("not_fully_checked");
			expect(
				receipt.decision.notChecked.map(
					(n: { findingId: string }) => n.findingId,
				),
			).toEqual(expect.arrayContaining(degraded.map((x) => x.findingId)));

			const list = gateRunListEnvelope.parse(
				await (await h.call(`/api/missions/${m.missionId}/gate-runs`)).json(),
			);
			expect(list.meta.total).toBe(1);
			expect(list.data[0]?.id).toBe(posted.id);
			expect(list.data[0]?.actor.kind).toBe("operator");
			expect(list.data[0]?.assurance).toBe("not_fully_checked");
			const read = successEnvelope(gateRunSchema).parse(
				await (
					await h.call(`/api/missions/${m.missionId}/gate-runs/${posted.id}`)
				).json(),
			).data;
			expect(read).toEqual(posted);

			const [logged] = await h.tx
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.missionId, m.missionId),
						eq(activityLog.action, "mission.gate_run"),
					),
				);
			expect(logged?.id).toBe(posted.id);

			// A run stored before decide() version 2 has no assurance on its
			// row or in its decision: it is read from the stored reasons. The
			// log is append-only, so the old run is a second row beside it.
			if (!logged) throw new Error("no gate run row");
			const v1 = JSON.parse(posted.receipt);
			delete v1.assurance;
			delete v1.decision.assurance;
			delete v1.decision.notChecked;
			const { assurance: _dropped, ...oldPayload } = logged.payload as Record<
				string,
				unknown
			>;
			const oldId = m.ids.next();
			await h.tx.insert(activityLog).values({
				...logged,
				id: oldId,
				payload: {
					...oldPayload,
					decideVersion: 1,
					receiptVersion: 1,
					receipt: JSON.stringify(v1),
				},
			});
			const old = successEnvelope(gateRunSchema).parse(
				await (
					await h.call(`/api/missions/${m.missionId}/gate-runs/${oldId}`)
				).json(),
			).data;
			expect([old.decideVersion, old.assurance]).toEqual([
				1,
				"not_fully_checked",
			]);
			const oldList = gateRunListEnvelope.parse(
				await (await h.call(`/api/missions/${m.missionId}/gate-runs`)).json(),
			);
			expect(oldList.data.find((x) => x.id === oldId)?.assurance).toBe(
				"not_fully_checked",
			);
		});
	});

	it("blocks, with no override, when a builder wrote a test file", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, {
				"src/b.ts": "export const b = 2;\n",
				"tests/b.test.ts": "it('passes', () => {});\n",
			});
			const res = await run(h, m.missionId);
			const posted = successEnvelope(gateRunSchema).parse(
				await res.json(),
			).data;
			expect(posted.verdict).toBe("block");
			const violation = posted.reasons.find(
				(x) => x.rule === "checkpoint_violation",
			);
			expect(violation?.subject).toContain("tests/b.test.ts");
			expect(violation?.overridable).toBe(false);

			const overridden = successEnvelope(gateRunSchema).parse(
				await (
					await run(h, m.missionId, {
						overrides: [
							{
								findingId: violation?.findingId,
								commitSha: posted.commitSha,
								rationale: "I wrote it",
							},
						],
					})
				).json(),
			).data;
			expect(overridden.verdict).toBe("block");
			expect(overridden.ignoredOverrides[0]?.why).toBe("not_overridable");
		});
	});

	it("replays a run by its idempotency key, and refuses the key with another body", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			await closedDispatch(h, m, r, { "src/b.ts": "export const b = 2;\n" });
			const key = "00000000-0000-4000-8000-0000000000aa";
			const first = await run(h, m.missionId, {}, key);
			expect(first.status).toBe(201);
			const again = await run(h, m.missionId, {}, key);
			expect(again.status).toBe(200);
			expect(again.headers.get("idempotency-replayed")).toBe("true");
			expect(
				successEnvelope(gateRunSchema).parse(await again.json()).data.id,
			).toBe(successEnvelope(gateRunSchema).parse(await first.json()).data.id);
			const other = await run(
				h,
				m.missionId,
				{
					overrides: [
						{ findingId: "x", commitSha: r.pinned, rationale: "different" },
					],
				},
				key,
			);
			expect(other.status).toBe(409);
		});
	});

	it("refuses with each precondition, naming what to fix", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			expect((await refusal(await run(h, m.missionId))).reason).toBe(
				"nothing_to_judge",
			);

			const a = await closedDispatch(h, m, r, { "src/x.ts": "1\n" });
			const b = await closedDispatch(h, m, r, { "src/x.ts": "2\n" });
			const conflict = await refusal(await run(h, m.missionId));
			expect(conflict.reason).toBe("integration_conflict");
			expect(conflict.issues).toEqual([
				{
					path: ["integration", "src/x.ts"],
					message: [a, b].sort().join(", "),
				},
			]);

			const bare = await closedDispatch(h, m, r, null);
			const missing = await refusal(await run(h, m.missionId));
			expect(missing.reason).toBe("dispatch_commit_missing");
			expect(missing.issues).toEqual([
				{ path: ["dispatches", bare], message: "no result commit" },
			]);

			const live = await insertDispatchRow(
				h.tx,
				m.ids,
				dispatchValues(m.agent, m.ids, "running"),
			);
			const running = await refusal(await run(h, m.missionId));
			expect(running.reason).toBe("dispatches_running");
			expect(running.issues).toEqual([
				{ path: ["dispatches", live], message: "running" },
			]);

			await h.tx
				.update(mission)
				.set({ status: "draft" })
				.where(eq(mission.id, m.missionId));
			expect((await refusal(await run(h, m.missionId))).reason).toBe(
				"mission_not_active",
			);
		});
	});

	it("answers 404 for an unknown mission or run", async () => {
		const r = repo();
		await gated(r, async (h, m) => {
			const missing = "00000000-0000-4000-8000-00000000ffff";
			expect((await run(h, missing)).status).toBe(404);
			expect(
				(await h.call(`/api/missions/${m.missionId}/gate-runs/${missing}`))
					.status,
			).toBe(404);
		});
	});
});
