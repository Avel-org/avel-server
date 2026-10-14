import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { activityLog, intake, mission } from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { FakeHarness } from "../../src/runner/harness";
import { gitIn, makeRepo, removeDir, tempDir } from "../unit/git-fixtures";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	type Mission,
	queued,
	row,
	start,
} from "./runner-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

// Start opens a real worktree room from a real local clone. The sources
// and rooms live in temp directories; nothing touches %LOCALAPPDATA%.

const base = tempDir("dispatch-rooms");
afterAll(() => removeDir(base));

const sources = path.join(base, "sources");
const templateClone = path.join(sources, "templates", "template-booking");
const [templateCommit] = makeRepo(templateClone, {
	"src/a.ts": "export const a = 1;\n",
}) as [string];
const repoClone = path.join(sources, "repos", "acme", "app");
const [repoCommit] = makeRepo(repoClone, {
	"README.md": "# App\n",
}) as [string];
mkdirSync(path.join(sources, "templates", "template-empty"), {
	recursive: true,
});

let n = 0;
/** A fresh rooms root per test, so worktree names never collide. */
function roomsRoot() {
	n += 1;
	return path.join(base, `rooms-${n}`);
}

async function refusal(res: Response) {
	expect(res.status).toBe(422);
	return errorEnvelope.parse(await res.json()).error.details as {
		reason: string;
		issues?: Array<{ path: unknown[]; message: string }>;
	};
}

/** A mission whose template points at `slug`@`commit`, or at nothing. */
async function sourced(
	tx: Tx,
	m: Mission,
	template: { slug: string; commit: string } | null,
) {
	await tx
		.update(mission)
		.set({
			type: template?.slug ?? "discovery",
			templateRef: template?.slug ?? null,
			templateVersion: template?.commit ?? null,
		})
		.where(eq(mission.id, m.missionId));
}

async function approvedIntake(
	h: ApiHarness,
	m: Mission,
	read: { repoUrl: string; commit: string } | null,
) {
	await h.tx.insert(intake).values({
		id: m.ids.next(),
		engagementId: m.engagementId,
		status: "approved",
		sourceMd: "# Ask",
		openQuestions: [],
		approvedBy: await h.operatorId(),
		approvedAt: clock.now(),
		missionId: m.missionId,
		repoUrl: read?.repoUrl ?? null,
		repoCommitSha: read?.commit ?? null,
		repoReadAt: read ? clock.now() : null,
		...stamp(clock),
	});
}

/** Nothing about a refused start was written, and no room was made. */
async function expectNoRun(h: ApiHarness, id: string, root: string) {
	expect((await row(h.tx, id)).status).toBe("queued");
	expect(
		await h.tx.select().from(activityLog).where(eq(activityLog.entityId, id)),
	).toEqual([]);
	expect(existsSync(path.join(root, id))).toBe(false);
	expect(existsSync(path.join(root, `${id}.json`))).toBe(false);
}

// Each case spawns several git processes. Alone the slowest takes about
// half a second, but under the full suite's parallel load on Windows it
// passed 5 seconds, so these tests get 30.
describe.skipIf(!process.env.DATABASE_URL)(
	"start opens the dispatch's room",
	{ timeout: 30_000 },
	() => {
		afterAll(closeDb);

		it("checks out the template's pinned commit as a worktree, with the entry's globs, and hands its root to the harness", async () => {
			const harness = new FakeHarness();
			const root = roomsRoot();
			const rooms = worktreeRooms(root);
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					await sourced(h.tx, m, {
						slug: "template-booking",
						commit: templateCommit,
					});
					const id = await queued(h.tx, m);
					const res = await start(h, id);
					expect(res.status).toBe(200);
					const room = await rooms.get(id);
					expect(room).toMatchObject({
						dispatchId: id,
						repoPath: templateClone,
						commit: templateCommit,
						writableGlobs: ["src/**"],
					});
					expect(room?.root).toBe(path.join(root, id));
					expect(gitIn(room?.root ?? "", "rev-parse", "HEAD")).toBe(
						templateCommit,
					);
					expect(harness.roomFor(id)).toBe(room?.root);
				},
				{ harness, rooms, roomSources: localSources(sources) },
			);
		});

		it("uses the one approved intake's repository when the mission has no template", async () => {
			const root = roomsRoot();
			const rooms = worktreeRooms(root);
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					await sourced(h.tx, m, null);
					await approvedIntake(h, m, {
						repoUrl: "https://github.com/acme/app",
						commit: repoCommit,
					});
					// Neither a draft intake nor a deleted approved one counts.
					await h.tx.insert(intake).values({
						id: m.ids.next(),
						engagementId: m.engagementId,
						status: "draft",
						sourceMd: "# Another ask",
						openQuestions: [],
						missionId: m.missionId,
						...stamp(clock),
					});
					await approvedIntake(h, m, {
						repoUrl: "https://github.com/acme/other",
						commit: repoCommit,
					});
					const [, deleted] = await h.tx
						.select({ id: intake.id })
						.from(intake)
						.where(
							and(
								eq(intake.missionId, m.missionId),
								eq(intake.status, "approved"),
							),
						)
						.orderBy(asc(intake.createdAt), asc(intake.id));
					await h.tx
						.update(intake)
						.set(remove(clock))
						.where(eq(intake.id, deleted?.id ?? ""));
					const id = await queued(h.tx, m);
					expect((await start(h, id)).status).toBe(200);
					expect(await rooms.get(id)).toMatchObject({
						repoPath: repoClone,
						commit: repoCommit,
					});
				},
				{ rooms, roomSources: localSources(sources) },
			);
		});

		it("refuses source_unavailable, never room_unavailable, for every source case, and makes no room", async () => {
			const cases: Array<{
				name: string;
				dir: string | undefined;
				setup: (h: ApiHarness, m: Mission) => Promise<void>;
				path: unknown[];
				message: RegExp;
			}> = [
				{
					name: "no template and no intake",
					dir: sources,
					setup: async (h, m) => sourced(h.tx, m, null),
					path: ["intake"],
					message: /^no approved intake$/,
				},
				{
					name: "two approved intakes",
					dir: sources,
					setup: async (h, m) => {
						await sourced(h.tx, m, null);
						const read = {
							repoUrl: "https://github.com/acme/app",
							commit: repoCommit,
						};
						await approvedIntake(h, m, read);
						await approvedIntake(h, m, read);
					},
					path: ["intake"],
					message: /^2 approved intakes$/,
				},
				{
					name: "an approved intake with no repository read",
					dir: sources,
					setup: async (h, m) => {
						await sourced(h.tx, m, null);
						await approvedIntake(h, m, null);
					},
					path: ["source", "repo"],
					message: /no repository read/,
				},
				{
					name: "AVEL_SOURCES_DIR unset",
					dir: undefined,
					setup: async (h, m) =>
						sourced(h.tx, m, {
							slug: "template-booking",
							commit: templateCommit,
						}),
					path: ["source", "template"],
					message: /AVEL_SOURCES_DIR is not set/,
				},
				{
					name: "the clone missing",
					dir: sources,
					setup: async (h, m) =>
						sourced(h.tx, m, {
							slug: "template-audit",
							commit: templateCommit,
						}),
					path: ["source", "template"],
					message:
						/No local clone of template template-audit at .*template-audit/,
				},
				{
					name: "the clone not a git repository",
					dir: sources,
					setup: async (h, m) =>
						sourced(h.tx, m, {
							slug: "template-empty",
							commit: templateCommit,
						}),
					path: ["source", "template"],
					message: /not the root of a git repository/,
				},
				{
					name: "the commit absent from the clone",
					dir: sources,
					setup: async (h, m) =>
						sourced(h.tx, m, { slug: "template-booking", commit: repoCommit }),
					path: ["source", "template"],
					message: new RegExp(`does not hold commit ${repoCommit}`),
				},
				{
					name: "the intake's repository with no clone",
					dir: sources,
					setup: async (h, m) => {
						await sourced(h.tx, m, null);
						await approvedIntake(h, m, {
							repoUrl: "https://github.com/acme/other",
							commit: repoCommit,
						});
					},
					path: ["source", "repo"],
					message: /No local clone of repository/,
				},
			];
			for (const c of cases) {
				const root = roomsRoot();
				await withApi(
					async (h) => {
						await h.signIn();
						const m = await activeMission(h.tx, seedIds(h.ns));
						await c.setup(h, m);
						const id = await queued(h.tx, m);
						const details = await refusal(await start(h, id));
						expect(details.reason, c.name).toBe("source_unavailable");
						expect(details.issues, c.name).toHaveLength(1);
						expect(details.issues?.[0]?.path, c.name).toEqual(c.path);
						expect(details.issues?.[0]?.message, c.name).toMatch(c.message);
						await expectNoRun(h, id, root);
					},
					{ rooms: worktreeRooms(root), roomSources: localSources(c.dir) },
				);
			}
		});

		it("refuses room_unavailable when the source resolves but the room cannot be made", async () => {
			const root = roomsRoot();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					await sourced(h.tx, m, {
						slug: "template-booking",
						commit: templateCommit,
					});
					const id = await queued(h.tx, m);
					mkdirSync(path.join(root, id), { recursive: true });
					expect((await refusal(await start(h, id))).reason).toBe(
						"room_unavailable",
					);
					expect((await row(h.tx, id)).status).toBe("queued");
					expect(existsSync(path.join(root, `${id}.json`))).toBe(false);
				},
				{ rooms: worktreeRooms(root), roomSources: localSources(sources) },
			);
		});

		it("orders source_unavailable before room_unavailable before harness_unavailable", async () => {
			const harness = new FakeHarness();
			harness.accepting = false;
			const root = roomsRoot();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					await sourced(h.tx, m, {
						slug: "template-audit",
						commit: templateCommit,
					});
					const id = await queued(h.tx, m);
					mkdirSync(path.join(root, id), { recursive: true });
					expect((await refusal(await start(h, id))).reason).toBe(
						"source_unavailable",
					);
					await sourced(h.tx, m, {
						slug: "template-booking",
						commit: templateCommit,
					});
					expect((await refusal(await start(h, id))).reason).toBe(
						"room_unavailable",
					);
					removeDir(path.join(root, id));
					expect((await refusal(await start(h, id))).reason).toBe(
						"harness_unavailable",
					);
				},
				{
					harness,
					rooms: worktreeRooms(root),
					roomSources: localSources(sources),
				},
			);
		});

		it("releases the room when the start fails after it opened (the harness refuses)", async () => {
			const harness = new FakeHarness();
			harness.accepting = false;
			const root = roomsRoot();
			const rooms = worktreeRooms(root);
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					await sourced(h.tx, m, {
						slug: "template-booking",
						commit: templateCommit,
					});
					const id = await queued(h.tx, m);
					expect((await refusal(await start(h, id))).reason).toBe(
						"harness_unavailable",
					);
					await expectNoRun(h, id, root);
					expect(await rooms.get(id)).toBeNull();
					expect(gitIn(templateClone, "worktree", "list")).not.toContain(id);
					// The same dispatch starts cleanly once the harness takes it.
					harness.accepting = true;
					expect((await start(h, id)).status).toBe(200);
					expect(await rooms.get(id)).not.toBeNull();
				},
				{ harness, rooms, roomSources: localSources(sources) },
			);
		});

		it("keeps the room after a halt, for the operator to inspect", async () => {
			const harness = new FakeHarness();
			const root = roomsRoot();
			const rooms = worktreeRooms(root);
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					await sourced(h.tx, m, {
						slug: "template-booking",
						commit: templateCommit,
					});
					const id = await queued(h.tx, m);
					expect((await start(h, id)).status).toBe(200);
					const halted = await h.call(`/api/dispatches/${id}/halt`, {
						method: "POST",
					});
					expect(halted.status).toBe(200);
					expect((await row(h.tx, id)).status).toBe("halted");
					expect(harness.stopped).toEqual([id]);
					const room = await rooms.get(id);
					expect(room).not.toBeNull();
					expect(existsSync(path.join(room?.root ?? "", "src", "a.ts"))).toBe(
						true,
					);
				},
				{ harness, rooms, roomSources: localSources(sources) },
			);
		});
	},
);
