import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { readTool, writeTool } from "../../src/rooms/tools";
import { FakeHarness } from "../../src/runner/harness";
import { gitIn, makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { bearer, seedIds } from "./agent-fixtures";
import { gateRunOf, jobDeps, postGate } from "./gate-job-fixtures";
import {
	activeClientMission,
	CLIENT_REPO,
	type ClientMission,
	queued,
	row,
	start,
} from "./runner-fixtures";
import { type ApiHarness, withApi } from "./support";

// Decided 2026-10-22: rooms start from finished work. A dispatch's room
// opens on the mission's base plus every complete dispatch closed before
// its start, in close order, and the dispatch records that commit and
// those dispatches. Two dispatches conflict on a path only when neither
// saw the other's change. Everything here goes through the real start and
// report routes, on real worktrees of a real clone.

const base = tempDir("rooms-start-from-work");
afterAll(() => removeDir(base));

const sources = path.join(base, "sources");
const clone = path.join(sources, "repos", "meridian-co", "app");
const [pinned] = makeRepo(clone, {
	"src/a.ts": "export const a = 0;\n",
	"README.md": "# app\n",
}) as [string];

let n = 0;
const roomsRoot = () => path.join(base, `rooms-${++n}`);

let idem = 0;
const key = (h: ApiHarness) =>
	`${h.ns}-0000-4000-b000-${(++idem).toString(16).padStart(12, "0")}`;

/** Starts a queued dispatch through the route, and hands back its room's tools. */
async function begin(
	h: ApiHarness,
	harness: FakeHarness,
	rooms: ReturnType<typeof worktreeRooms>,
	m: ClientMission,
) {
	const id = await queued(h.tx, m, {
		briefRef: { moduleId: "M6", requirementIds: ["R1"] },
	});
	const res = await start(h, id);
	expect(res.status, await res.clone().text()).toBe(200);
	const room = await rooms.get(id);
	if (!room) throw new Error(`no room for ${id}`);
	const token = harness.tokenFor(id) as string;
	return { id, room, token };
}

/** The agent's complete report, through the route: it closes the dispatch and commits its room. */
async function report(h: ApiHarness, token: string) {
	const res = await h.app.request("/api/agent/report", {
		method: "POST",
		headers: {
			...bearer(token),
			"content-type": "application/json",
			"idempotency-key": key(h),
		},
		body: JSON.stringify({
			status: "complete",
			artifactsRead: [],
			blockers: [],
			rereads: 0,
		}),
	});
	expect(res.status, await res.clone().text()).toBe(201);
}

describe.skipIf(!process.env.DATABASE_URL)(
	"rooms start from finished work",
	{ timeout: 60_000 },
	() => {
		afterAll(closeDb);

		it("starts a later dispatch on the work finished before it, records it, and gates its change to that work", async () => {
			const harness = new FakeHarness();
			const rooms = worktreeRooms(roomsRoot());
			const roomSources = localSources(sources);
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeClientMission(h, seedIds(h.ns), {
						repoUrl: CLIENT_REPO,
						commit: pinned,
					});
					jobDeps(h, roomSources);

					// The first starts on the base: nothing has finished.
					const one = await begin(h, harness, rooms, m);
					expect(one.room.commit).toBe(pinned);
					await writeTool(one.room, "src/a.ts", "export const a = 1;\n");
					await writeTool(one.room, "src/b.ts", "export const b = 1;\n");
					await report(h, one.token);
					const first = await row(h.tx, one.id);
					expect([first.startCommitSha, first.startDispatchIds]).toEqual([
						pinned,
						[],
					]);

					// The second starts on the first's work, and says so.
					const two = await begin(h, harness, rooms, m);
					expect(two.room.commit).not.toBe(pinned);
					expect(gitIn(two.room.root, "rev-parse", "HEAD")).toBe(
						two.room.commit,
					);
					expect((await readTool(two.room, "src/b.ts")).trim()).toBe(
						"export const b = 1;",
					);
					const second = await row(h.tx, two.id);
					expect(second.startCommitSha).toBe(two.room.commit);
					expect(second.startDispatchIds).toEqual([one.id]);
					const wire = (await (
						await h.call(`/api/dispatches/${two.id}`)
					).json()) as {
						data: { startCommitSha: string; startDispatchIds: string[] };
					};
					expect(wire.data).toMatchObject({
						startCommitSha: two.room.commit,
						startDispatchIds: [one.id],
					});

					// It changes the first's file: no conflict, it saw that change.
					await writeTool(two.room, "src/a.ts", "export const a = 2;\n");
					await report(h, two.token);
					const run = await gateRunOf(h, m.missionId);
					expect(run.baseSha).toBe(pinned);
					const at = (p: string) =>
						gitIn(clone, "show", `${run.commitSha}:${p}`).trim();
					expect(at("src/a.ts")).toBe("export const a = 2;");
					expect(at("src/b.ts")).toBe("export const b = 1;");
				},
				{ harness, rooms, roomSources },
			);
		});

		it("refuses a start, and the gate, when two finished dispatches changed a path neither saw the other change", async () => {
			const harness = new FakeHarness();
			const rooms = worktreeRooms(roomsRoot());
			const roomSources = localSources(sources);
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeClientMission(h, seedIds(h.ns), {
						repoUrl: CLIENT_REPO,
						commit: pinned,
					});
					jobDeps(h, roomSources);

					// Both start before either finishes, so neither sees the other.
					const one = await begin(h, harness, rooms, m);
					const two = await begin(h, harness, rooms, m);
					expect(two.room.commit).toBe(pinned);
					await writeTool(one.room, "src/a.ts", "export const a = 1;\n");
					await writeTool(two.room, "src/a.ts", "export const a = 2;\n");
					await report(h, one.token);
					await report(h, two.token);

					// The gate refuses the pair too (asked before a third is queued,
					// which it would refuse as still running).
					const gate = await postGate(h, m.missionId);
					expect(gate.status).toBe(422);
					expect(
						((await gate.json()) as { error: { details: { reason: string } } })
							.error.details.reason,
					).toBe("integration_conflict");

					const three = await queued(h.tx, m, {
						briefRef: { moduleId: "M6", requirementIds: ["R1"] },
					});
					const refused = await start(h, three);
					expect(refused.status).toBe(422);
					const body = (await refused.json()) as {
						error: {
							details: {
								reason: string;
								issues: { path: string[]; message: string }[];
							};
						};
					};
					expect(body.error.details.reason).toBe("integration_conflict");
					expect(body.error.details.issues).toEqual([
						{
							path: ["integration", "src/a.ts"],
							message: [one.id, two.id].sort().join(", "),
						},
					]);
					expect((await row(h.tx, three)).status).toBe("queued");
					expect(await rooms.get(three)).toBeNull();
				},
				{ harness, rooms, roomSources },
			);
		});
	},
);
