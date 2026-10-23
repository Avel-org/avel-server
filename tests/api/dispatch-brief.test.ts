import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { dispatchBrief, successEnvelope } from "../../src/contract";
import type { BriefCheck } from "../../src/contract/intake";
import { closeDb } from "../../src/db/client";
import { activityLog, mission } from "../../src/db/schema";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { briefSha256 } from "../../src/runner/brief";
import { FakeHarness } from "../../src/runner/harness";
import { DISPATCH_PLAN } from "../db/dispatch-fixtures";
import { gitIn, makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { seedIds } from "./agent-fixtures";
import {
	activeClientMission,
	approvedIntake,
	CLIENT_REPO,
	queued,
	row,
	start,
} from "./runner-fixtures";
import { type ApiHarness, withApi } from "./support";

// Start renders the brief from the plan and a real clone, and freezes it.
// The mission is a client mission, so the clone is the client's repository
// and the brief carries its intake's source. The intake read the first
// commit; the second changes a file and adds one, so a brief read at HEAD
// instead of the commit read would show it.

const base = tempDir("dispatch-brief");
afterAll(() => removeDir(base));

const sources = path.join(base, "sources");
const clone = path.join(sources, "repos", "meridian-co", "app");
const [pinned] = makeRepo(
	clone,
	{
		"src/auth/signup.ts": "export const signup = 1;\n",
		"src/auth/signin.ts": "export const signin = 1;\n",
		"src/other.ts": "export const other = 1;\n",
	},
	{
		"src/auth/signup.ts": "export const signup = 2;\n",
		"src/auth/later.ts": "export const later = 1;\n",
	},
) as [string, string];

const blob = (p: string) => gitIn(clone, "rev-parse", `${pinned}:${p}`);

let n = 0;
function roomsRoot() {
	n += 1;
	return path.join(base, `rooms-${n}`);
}

const briefRead = successEnvelope(dispatchBrief);

async function getBrief(h: ApiHarness, id: string) {
	const res = await h.call(`/api/dispatches/${id}/brief`);
	expect(res.status).toBe(200);
	return briefRead.parse(await res.json()).data;
}

describe.skipIf(!process.env.DATABASE_URL)(
	"start freezes the dispatch's brief",
	{ timeout: 30_000 },
	() => {
		afterAll(closeDb);

		it("renders the module's reads at the room's commit with the intake's source, and serves it", async () => {
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeClientMission(h, seedIds(h.ns), null);
					const plan = structuredClone(DISPATCH_PLAN);
					(plan.modules[0] as { reads: string[] }).reads = [
						"src/auth",
						"docs/none.md",
					];
					await h.tx
						.update(mission)
						.set({ brief: plan })
						.where(eq(mission.id, m.missionId));
					await approvedIntake(
						h,
						m,
						{ repoUrl: CLIENT_REPO, commit: pinned },
						"# The ask\n\nAccounts, please.",
					);
					const id = await queued(h.tx, m);

					// Queued: nothing frozen yet.
					expect(await getBrief(h, id)).toEqual({
						dispatchId: id,
						briefSha256: null,
						briefMd: null,
					});

					expect((await start(h, id)).status).toBe(200);
					const d = await row(h.tx, id);
					const md = d.briefMd as string;
					expect(d.briefSha256).toBe(briefSha256(md));
					expect(await getBrief(h, id)).toEqual({
						dispatchId: id,
						briefSha256: d.briefSha256,
						briefMd: md,
					});

					const read = md.split("## Read")[1]?.split("## Method")[0] ?? "";
					expect(read).toContain(`Repository paths at commit \`${pinned}\`.`);
					expect(read.match(/^ *- .*$/gm)).toEqual([
						"- `src/auth`: 2 files",
						`  - \`src/auth/signin.ts\` ${blob("src/auth/signin.ts")}`,
						`  - \`src/auth/signup.ts\` ${blob("src/auth/signup.ts")}`,
						"- `docs/none.md`: matches nothing at this commit",
					]);
					expect(read).toContain("# The ask\n\nAccounts, please.");
					expect(md).toContain("- CK1 (R1, test): `pnpm test R1` passes.");
					expect(md).toContain("- CK2 (R2, test): `pnpm test R2` passes.");

					const [started] = await h.tx
						.select({ payload: activityLog.payload })
						.from(activityLog)
						.where(
							and(
								eq(activityLog.entityId, id),
								eq(activityLog.action, "dispatch.started"),
							),
						);
					expect(started?.payload).toMatchObject({
						briefSha256: d.briefSha256,
					});
				},
				{
					rooms: worktreeRooms(roomsRoot()),
					roomSources: localSources(sources),
				},
			);
		});

		it("freezes no brief for a dispatch with no briefRef", async () => {
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeClientMission(h, seedIds(h.ns), {
						repoUrl: CLIENT_REPO,
						commit: pinned,
					});
					const id = await queued(h.tx, m, { briefRef: null });
					expect((await start(h, id)).status).toBe(200);
					expect(await getBrief(h, id)).toEqual({
						dispatchId: id,
						briefSha256: null,
						briefMd: null,
					});
				},
				{
					rooms: worktreeRooms(roomsRoot()),
					roomSources: localSources(sources),
				},
			);
		});

		it("hands the harness the room's clone and commit, and only this dispatch's checks that need a runner", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeClientMission(h, seedIds(h.ns), null);
					const plan = structuredClone(DISPATCH_PLAN);
					(plan.checks as BriefCheck[]).push({
						id: "CK3",
						requirementId: "R1",
						kind: "file_exists",
						path: "src/auth/signup.ts",
					});
					await h.tx
						.update(mission)
						.set({ brief: plan })
						.where(eq(mission.id, m.missionId));
					await approvedIntake(
						h,
						m,
						{ repoUrl: CLIENT_REPO, commit: pinned },
						"# The ask",
					);
					const id = await queued(h.tx, m, {
						briefRef: { moduleId: "M6", requirementIds: ["R1"] },
					});
					expect((await start(h, id)).status).toBe(200);
					expect(harness.sessionFor(id)).toMatchObject({
						roomRepoPath: clone,
						roomCommit: pinned,
						checks: [
							{
								id: "CK1",
								requirementId: "R1",
								kind: "test",
								command: "pnpm test R1",
							},
						],
					});

					const bare = await queued(h.tx, m, { briefRef: null });
					expect((await start(h, bare)).status).toBe(200);
					expect(harness.sessionFor(bare)?.checks).toEqual([]);
				},
				{
					harness,
					rooms: worktreeRooms(roomsRoot()),
					roomSources: localSources(sources),
				},
			);
		});

		it("answers 404 for a dispatch that does not exist", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const res = await h.call(
					"/api/dispatches/00000000-0000-4000-8000-00000000ffff/brief",
				);
				expect(res.status).toBe(404);
			});
		});
	},
);
