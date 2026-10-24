import { renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	type IntegrationPlan,
	planIntegration,
} from "../../src/lib/gate/integration";
import { changedFiles } from "../../src/rooms/checkpoint";
import { type Room, worktreeRooms } from "../../src/rooms/provider";
import {
	buildIntegrationCommit,
	dispatchChanges,
	dispatchRef,
	IntegrationRefused,
	readPackageJsonScripts,
	readTree,
	snapshotDispatch,
} from "../../src/rooms/snapshot";
import {
	gitIn,
	makeRepo,
	removeDir,
	tempDir,
	writeFiles,
} from "./git-fixtures";

// Dispatch commits, the integration commit and tree reads, against a temp
// repository. Plumbing only: nothing here touches a room's own index or HEAD.

// Each test makes repositories and worktrees and runs git many times.
vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("snapshot");
afterAll(() => removeDir(base));

const FILES = {
	".gitignore": "out/\n",
	"src/a.ts": "export const a = 1;\n",
	"src/d.ts": "export const d = 4;\n",
	"src/r.ts":
		"export const r = 'a long enough line to be found as a rename';\n",
	"src/s.ts":
		"export const s1 = 1;\nexport const s2 = 2;\nexport const s3 = 3;\nexport const s4 = 4;\n",
	"package.json": '{ "name": "salon", "scripts": { "test": "vitest run" } }\n',
	"vitest.config.ts": "export default {};\n",
};

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const T1 = "2026-10-19T09:00:00.000Z";
const T2 = "2026-10-19T10:30:00.000Z";

async function setup(next?: Record<string, string>) {
	const dir = path.join(base, `repo-${++n}`);
	const commits = makeRepo(dir, FILES, next);
	const rooms = worktreeRooms(path.join(base, `rooms-${n}`));
	const open = (commit = commits[0] as string): Promise<Room> =>
		rooms.open({
			dispatchId: id(),
			repoPath: dir,
			commit,
			writableGlobs: ["**"],
		});
	return { dir, pinned: commits[0] as string, commits, open };
}

const show = (dir: string, spec: string) => gitIn(dir, "show", spec);

async function refused(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		expect(err).toBeInstanceOf(IntegrationRefused);
		return (err as IntegrationRefused).details;
	}
	throw new Error("expected a refusal");
}

describe("snapshotDispatch", () => {
	it("commits the room's bytes on the pinned commit, as AVEL at closedAt, under the dispatch ref", async () => {
		const { dir, pinned, open } = await setup();
		const room = await open();
		writeFiles(room.root, {
			"src/a.ts": "export const a = 2;\r\n",
			"out/build.js": "x\n",
		});
		unlinkSync(path.join(room.root, "src", "d.ts"));
		const sha = await snapshotDispatch(room, pinned, room.dispatchId, T1);

		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(gitIn(dir, "rev-parse", dispatchRef(room.dispatchId))).toBe(sha);
		expect(gitIn(dir, "rev-parse", `${sha}^`)).toBe(pinned);
		expect(
			gitIn(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%at|%ct", sha),
		).toBe(
			`AVEL <avel@localhost>|AVEL <avel@localhost>|${Date.parse(T1) / 1000}|${Date.parse(T1) / 1000}`,
		);
		// Bytes as written, CRLF kept; ignored files included, like the checkpoint.
		// 19 characters plus CRLF. gitIn trims, which would hide the CR, so count bytes.
		expect(gitIn(dir, "cat-file", "-s", `${sha}:src/a.ts`)).toBe("21");
		expect(show(dir, `${sha}:out/build.js`)).toBe("x");
		expect(gitIn(dir, "ls-tree", "--name-only", sha, "--", "src/d.ts")).toBe(
			"",
		);
		// The room itself is untouched: still detached at pinned, edits uncommitted.
		expect(gitIn(room.root, "rev-parse", "HEAD")).toBe(pinned);
		expect(gitIn(room.root, "status", "--porcelain")).toContain("src/a.ts");
	});

	it("gives the same sha for the same bytes at the same closedAt, and another sha otherwise", async () => {
		const { pinned, open } = await setup();
		const room = await open();
		writeFiles(room.root, { "src/a.ts": "export const a = 3;\n" });
		const once = await snapshotDispatch(room, pinned, room.dispatchId, T1);
		const twice = await snapshotDispatch(room, pinned, room.dispatchId, T1);
		expect(twice).toBe(once);
		expect(await snapshotDispatch(room, pinned, room.dispatchId, T2)).not.toBe(
			once,
		);
		writeFiles(room.root, { "src/a.ts": "export const a = 4;\n" });
		expect(await snapshotDispatch(room, pinned, room.dispatchId, T1)).not.toBe(
			once,
		);
	});

	it("refuses a dispatch id, pinned sha or closedAt out of format", async () => {
		const { pinned, open } = await setup();
		const room = await open();
		await expect(snapshotDispatch(room, pinned, "../main", T1)).rejects.toThrow(
			/dispatch/,
		);
		await expect(
			snapshotDispatch(room, "HEAD", room.dispatchId, T1),
		).rejects.toThrow(/pinned/);
		await expect(
			snapshotDispatch(room, pinned, room.dispatchId, "2026-10-19 09:00"),
		).rejects.toThrow(/closedAt/);
	});
});

describe("dispatchChanges", () => {
	it("agrees with the checkpoint's own diff on adds, edits, deletes and renames", async () => {
		const { dir, pinned, open } = await setup();
		const room = await open();
		const at = (rel: string) => path.join(room.root, ...rel.split("/"));
		writeFiles(room.root, {
			"src/a.ts": "export const a = 9;\n",
			"src/new.ts": "new\n",
			"out/x.js": "x\n",
		});
		unlinkSync(at("src/d.ts"));
		renameSync(at("src/r.ts"), at("src/r2.ts"));
		// Moved and edited a little: a rename by similarity, not by identity.
		unlinkSync(at("src/s.ts"));
		writeFiles(room.root, {
			// Three of four lines kept: similar enough for git to call it a rename.
			"lib/s.ts":
				"export const s1 = 1;\nexport const s2 = 2;\nexport const s3 = 3;\nexport const s4 = 40;\n",
		});
		const sha = await snapshotDispatch(room, pinned, room.dispatchId, T1);

		const fromCommit = await dispatchChanges(dir, pinned, sha);
		expect(fromCommit).toEqual(await changedFiles(room.root, pinned));
		expect(fromCommit).toEqual([
			{ kind: "renamed", from: "src/s.ts", path: "lib/s.ts" },
			{ kind: "added", path: "out/x.js" },
			{ kind: "modified", path: "src/a.ts" },
			{ kind: "deleted", path: "src/d.ts" },
			{ kind: "added", path: "src/new.ts" },
			{ kind: "renamed", from: "src/r.ts", path: "src/r2.ts" },
		]);
	});
});

describe("buildIntegrationCommit", () => {
	async function twoDispatches() {
		const s = await setup();
		const a = await s.open();
		writeFiles(a.root, { "src/a.ts": "export const a = 10;\n" });
		unlinkSync(path.join(a.root, "src", "d.ts"));
		const b = await s.open();
		writeFiles(b.root, { "src/b/new.ts": "export const n = 1;\n" });
		renameSync(
			path.join(b.root, "src", "r.ts"),
			path.join(b.root, "src", "r2.ts"),
		);
		const shaA = await snapshotDispatch(a, s.pinned, a.dispatchId, T1);
		const shaB = await snapshotDispatch(b, s.pinned, b.dispatchId, T2);
		const plan = planIntegration({
			baseSha: s.pinned,
			dispatches: [
				{
					id: b.dispatchId,
					status: "complete",
					closedAt: T2,
					changes: await dispatchChanges(s.dir, s.pinned, shaB),
				},
				{
					id: a.dispatchId,
					status: "complete",
					closedAt: T1,
					changes: await dispatchChanges(s.dir, s.pinned, shaA),
				},
			],
		});
		return { ...s, a, b, plan };
	}

	it("lays every complete dispatch onto the base, as AVEL at the latest close", async () => {
		const { dir, pinned, plan } = await twoDispatches();
		const { sha } = await buildIntegrationCommit(dir, plan);
		expect(gitIn(dir, "rev-parse", `${sha}^`)).toBe(pinned);
		expect(gitIn(dir, "log", "-1", "--format=%an <%ae>|%at", sha)).toBe(
			`AVEL <avel@localhost>|${Date.parse(T2) / 1000}`,
		);
		const tree = await readTree(dir, sha);
		expect(Object.keys(tree).sort()).toEqual(
			[
				".gitignore",
				"package.json",
				"src/a.ts",
				"src/b/new.ts",
				"src/r2.ts",
				"src/s.ts",
				"vitest.config.ts",
			].sort(),
		);
		expect(show(dir, `${sha}:src/a.ts`)).toBe("export const a = 10;");
		expect(show(dir, `${sha}:src/b/new.ts`)).toBe("export const n = 1;");
		// The source clone's own index and HEAD are untouched.
		expect(gitIn(dir, "status", "--porcelain")).toBe("");
	});

	it("gives the same sha for the same plan and refs", async () => {
		const { dir, plan } = await twoDispatches();
		const once = await buildIntegrationCommit(dir, plan);
		expect(await buildIntegrationCommit(dir, plan)).toEqual(once);
	});

	it("refuses a conflict, an empty plan, a missing ref, a ref off the base, and a write the ref lacks", async () => {
		const { dir, pinned, plan, a } = await twoDispatches();
		if (!plan.ok) throw new Error("expected a plan");

		const conflict: IntegrationPlan = {
			ok: false,
			baseSha: pinned,
			conflicts: [{ path: "src/a.ts", dispatchIds: ["x", "y"] }],
			excluded: [],
		};
		expect(await refused(buildIntegrationCommit(dir, conflict))).toMatchObject({
			reason: "integration_conflict",
			conflicts: conflict.conflicts,
		});
		expect(
			await refused(buildIntegrationCommit(dir, { ...plan, steps: [] })),
		).toMatchObject({ reason: "nothing_to_judge" });

		const ghost = id();
		expect(
			await refused(
				buildIntegrationCommit(dir, {
					...plan,
					steps: [
						{
							dispatchId: ghost,
							closedAt: T1,
							startSha: plan.baseSha,
							ops: [],
						},
					],
				}),
			),
		).toMatchObject({ reason: "dispatch_commit_missing", dispatchId: ghost });

		const lying = {
			...plan,
			steps: [
				{
					dispatchId: a.dispatchId,
					closedAt: T1,
					startSha: plan.baseSha,
					ops: [{ op: "write" as const, path: "src/never.ts" }],
				},
			],
		};
		expect(await refused(buildIntegrationCommit(dir, lying))).toMatchObject({
			reason: "plan_mismatch",
			dispatchId: a.dispatchId,
			path: "src/never.ts",
		});
	});

	it("refuses a dispatch commit made on another base", async () => {
		const s = await setup({ "src/a.ts": "export const a = 100;\n" });
		const later = s.commits[1] as string;
		const room = await s.open(later);
		writeFiles(room.root, { "src/x.ts": "x\n" });
		const sha = await snapshotDispatch(room, later, room.dispatchId, T1);
		const plan = planIntegration({
			baseSha: s.pinned,
			dispatches: [
				{
					id: room.dispatchId,
					status: "complete",
					closedAt: T1,
					changes: await dispatchChanges(s.dir, later, sha),
				},
			],
		});
		expect(await refused(buildIntegrationCommit(s.dir, plan))).toMatchObject({
			reason: "dispatch_commit_off_base",
			dispatchId: room.dispatchId,
		});
	});
});

describe("readTree and readPackageJsonScripts", () => {
	it("reads a commit's blobs, path to blob sha", async () => {
		const { dir, pinned } = await setup();
		const tree = await readTree(dir, pinned);
		expect(Object.keys(tree).sort()).toEqual(Object.keys(FILES).sort());
		expect(tree["src/a.ts"]).toBe(
			gitIn(dir, "rev-parse", `${pinned}:src/a.ts`),
		);
	});

	it("reads package.json's scripts, or says it is absent or unparseable", async () => {
		const { dir, pinned, open } = await setup();
		expect(await readPackageJsonScripts(dir, pinned)).toEqual({
			kind: "scripts",
			scripts: { test: "vitest run" },
		});
		const cases: Array<[string | null, unknown]> = [
			['{ "name": "x" }', { kind: "scripts", scripts: {} }],
			["{ not json", { kind: "unparseable" }],
			['{ "scripts": ["test"] }', { kind: "unparseable" }],
			['{ "scripts": { "test": 1 } }', { kind: "unparseable" }],
			["[]", { kind: "unparseable" }],
			[null, { kind: "absent" }],
		];
		for (const [content, expected] of cases) {
			const room = await open();
			if (content === null) unlinkSync(path.join(room.root, "package.json"));
			else writeFiles(room.root, { "package.json": content });
			const sha = await snapshotDispatch(room, pinned, room.dispatchId, T1);
			expect(
				await readPackageJsonScripts(dir, sha),
				String(content),
			).toMatchObject(expected as object);
		}
	});

	it("reads only the root package.json", async () => {
		const { dir, pinned, open } = await setup();
		const room = await open();
		unlinkSync(path.join(room.root, "package.json"));
		writeFiles(room.root, {
			"packages/web/package.json": '{ "scripts": { "a": "b" } }',
		});
		const sha = await snapshotDispatch(room, pinned, room.dispatchId, T1);
		expect(await readPackageJsonScripts(dir, sha)).toEqual({ kind: "absent" });
	});
});
