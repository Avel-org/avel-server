import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "../../src/middleware/errors";
import {
	changedFiles,
	checkpointIssues,
	exitCheckpoint,
	parseNameStatus,
} from "../../src/rooms/checkpoint";
import { RoomUnavailable, worktreeRooms } from "../../src/rooms/provider";
import { cloneDir, localSources, ownerRepo } from "../../src/rooms/sources";
import {
	gitIn,
	makeRepo,
	removeDir,
	tempDir,
	writeFiles,
} from "./git-fixtures";

// The real worktree provider, sources and checkpoint against temp git
// repositories. Files are written with LF, and every git call pins
// core.autocrlf=false, so nothing here depends on line-ending settings.

const base = tempDir("rooms");
afterAll(() => removeDir(base));

const FILES = {
	"src/a.ts": "export const a = 1;\n",
	"src/b.ts": "export const b = 2;\n",
	"tests/a.test.ts": "test\n",
	"docs/readme.md": "# Readme\n",
	".gitignore": "*.log\n",
};

let n = 0;
const fresh = (label: string) => {
	n += 1;
	return path.join(base, `${label}-${n}`);
};
const id = (k: number) =>
	`00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;

describe("worktreeRooms", () => {
	const repo = fresh("repo");
	const [first, second] = makeRepo(repo, FILES, {
		"src/a.ts": "export const a = 10;\n",
	}) as [string, string];

	it("opens a detached worktree at the pinned commit, records it, and gets it back", async () => {
		const rootDir = fresh("rooms-root");
		const rooms = worktreeRooms(rootDir);
		const room = await rooms.open({
			dispatchId: id(1),
			repoPath: repo,
			commit: first,
			writableGlobs: ["src/**"],
		});
		expect(room).toMatchObject({
			dispatchId: id(1),
			repoPath: repo,
			commit: first,
			writableGlobs: ["src/**"],
		});
		expect(path.relative(rootDir, room.root)).toBe(id(1));
		expect(gitIn(room.root, "rev-parse", "HEAD")).toBe(first);
		// The first commit's bytes, LF, whatever the machine's autocrlf.
		expect(readFileSync(path.join(room.root, "src", "a.ts"), "utf8")).toBe(
			"export const a = 1;\n",
		);
		expect(await rooms.get(id(1))).toEqual(room);
		expect(await rooms.get(id(2))).toBeNull();
		expect(await rooms.get("../escape")).toBeNull();
		// A record outside the rooms root is never read, even a well-formed one.
		writeFileSync(
			path.join(rootDir, "..", "escape.json"),
			JSON.stringify({ ...room, dispatchId: "../escape" }),
		);
		expect(await rooms.get("../escape")).toBeNull();
	});

	it("never trusts a record whose root is not the dispatch's own directory", async () => {
		const rootDir = fresh("rooms-root");
		const rooms = worktreeRooms(rootDir);
		const room = await rooms.open({
			dispatchId: id(5),
			repoPath: repo,
			commit: first,
			writableGlobs: ["src/**"],
		});
		const record = path.join(rootDir, `${id(5)}.json`);
		const elsewhere = fresh("elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		for (const root of [elsewhere, path.join(rootDir, id(6))]) {
			writeFileSync(record, JSON.stringify({ ...room, root }));
			expect(await rooms.get(id(5)), root).toBeNull();
		}
		// Put back, it is the room again.
		writeFileSync(record, JSON.stringify(room));
		expect(await rooms.get(id(5))).toEqual(room);
	});

	it("refuses (RoomUnavailable) an existing room, a missing commit, a non-repo, a bad id", async () => {
		const rootDir = fresh("rooms-root");
		const rooms = worktreeRooms(rootDir);
		const spec = {
			dispatchId: id(1),
			repoPath: repo,
			commit: first,
			writableGlobs: ["src/**"],
		};
		await rooms.open(spec);
		await expect(rooms.open(spec)).rejects.toBeInstanceOf(RoomUnavailable);
		await expect(
			rooms.open({ ...spec, dispatchId: id(2), commit: "f".repeat(40) }),
		).rejects.toBeInstanceOf(RoomUnavailable);
		await expect(
			rooms.open({ ...spec, dispatchId: id(3), repoPath: fresh("not-a-repo") }),
		).rejects.toBeInstanceOf(RoomUnavailable);
		await expect(
			rooms.open({ ...spec, dispatchId: "../../escape" }),
		).rejects.toBeInstanceOf(RoomUnavailable);
		await expect(
			rooms.open({ ...spec, dispatchId: id(4), commit: "HEAD" }),
		).rejects.toBeInstanceOf(RoomUnavailable);
		for (const k of [2, 3, 4]) {
			expect(existsSync(path.join(rootDir, id(k)))).toBe(false);
			expect(await rooms.get(id(k))).toBeNull();
		}
	});

	it("refuses when the rooms root cannot be made", async () => {
		const blocker = fresh("file");
		writeFileSync(blocker, "a file, not a directory");
		const rooms = worktreeRooms(path.join(blocker, "rooms"));
		await expect(
			rooms.open({
				dispatchId: id(1),
				repoPath: repo,
				commit: first,
				writableGlobs: [],
			}),
		).rejects.toBeInstanceOf(RoomUnavailable);
	});

	it("releases a room: the worktree, its registration and its record go", async () => {
		const rootDir = fresh("rooms-root");
		const rooms = worktreeRooms(rootDir);
		const room = await rooms.open({
			dispatchId: id(9),
			repoPath: repo,
			commit: second,
			writableGlobs: [],
		});
		writeFiles(room.root, { "src/dirty.ts": "dirty\n" });
		await rooms.release(id(9));
		expect(existsSync(room.root)).toBe(false);
		expect(existsSync(path.join(rootDir, `${id(9)}.json`))).toBe(false);
		expect(await rooms.get(id(9))).toBeNull();
		expect(gitIn(repo, "worktree", "list")).not.toContain(id(9));
		// Nothing to release is nothing.
		await rooms.release(id(9));
		await expect(rooms.release("../x")).rejects.toThrow(/names no room/);
	});

	it("refuses to release a room directory that leads outside the rooms root", async () => {
		const rootDir = fresh("rooms-root");
		const rooms = worktreeRooms(rootDir);
		const room = await rooms.open({
			dispatchId: id(1),
			repoPath: repo,
			commit: first,
			writableGlobs: [],
		});
		// Swap the room for a junction to a directory outside the root.
		const victim = fresh("victim");
		writeFiles(victim, { "keep.txt": "keep\n" });
		const moved = fresh("moved-room");
		renameSync(room.root, moved);
		symlinkSync(victim, room.root, "junction");
		await expect(rooms.release(id(1))).rejects.toThrow(/is not under/);
		expect(readFileSync(path.join(victim, "keep.txt"), "utf8")).toBe("keep\n");
	});
});

describe("localSources", () => {
	const sources = fresh("sources");
	const template = path.join(sources, "templates", "template-booking");
	const [commit] = makeRepo(template, FILES) as [string];
	const repoClone = path.join(sources, "repos", "acme", "app");
	const [repoCommit] = makeRepo(repoClone, FILES) as [string];
	mkdirSync(path.join(sources, "templates", "not-a-repo"), { recursive: true });
	const resolver = localSources(sources);
	const issueOf = async (
		s: Parameters<typeof resolver.resolve>[0],
	): Promise<{ path: unknown; message: string }> => {
		const r = await resolver.resolve(s);
		if (r.ok) throw new Error("resolved");
		return r.issue;
	};

	it("resolves a template and a repository clone holding the commit", async () => {
		expect(
			await resolver.resolve({
				kind: "template",
				slug: "template-booking",
				commit,
			}),
		).toEqual({ ok: true, repoPath: template, commit });
		expect(
			await resolver.resolve({
				kind: "repo",
				repoUrl: "https://github.com/acme/app",
				commit: repoCommit,
			}),
		).toEqual({ ok: true, repoPath: repoClone, commit: repoCommit });
	});

	it("names the case: unset, missing clone, not a repository, commit absent, unsafe name", async () => {
		const unset = await localSources(undefined).resolve({
			kind: "template",
			slug: "template-booking",
			commit,
		});
		expect(unset).toMatchObject({
			ok: false,
			issue: { path: ["source", "template"] },
		});
		expect(!unset.ok && unset.issue.message).toMatch(/AVEL_SOURCES_DIR/);

		const missing = await issueOf({
			kind: "template",
			slug: "template-audit",
			commit,
		});
		expect(missing.path).toEqual(["source", "template"]);
		expect(missing.message).toContain(
			path.join(sources, "templates", "template-audit"),
		);

		expect(
			(await issueOf({ kind: "template", slug: "not-a-repo", commit })).message,
		).toMatch(/not the root of a git repository/);
		expect(cloneDir(sources, { kind: "template", slug: "x", commit })).toBe(
			path.join(sources, "templates", "x"),
		);
		// A directory inside some repository is not a clone: git would
		// resolve upwards to the enclosing repository.
		const outer = fresh("outer-sources");
		makeRepo(path.join(outer, "templates"), {
			"inner/a.ts": "a\n",
		});
		const inner = await localSources(outer).resolve({
			kind: "template",
			slug: "inner",
			commit,
		});
		expect(inner).toMatchObject({ ok: false });
		expect(!inner.ok && inner.issue.message).toMatch(
			/not the root of a git repository/,
		);

		const absent = await issueOf({
			kind: "repo",
			repoUrl: "https://github.com/acme/app",
			commit: "f".repeat(40),
		});
		expect(absent.path).toEqual(["source", "repo"]);
		expect(absent.message).toContain("f".repeat(40));

		for (const slug of ["../escape", "Template", ".hidden"]) {
			expect(
				(await issueOf({ kind: "template", slug, commit })).message,
				slug,
			).toMatch(/no safe local clone name/);
		}
		expect(
			(
				await issueOf({
					kind: "repo",
					repoUrl: "https://github.com/acme/app/extra",
					commit,
				})
			).message,
		).toMatch(/no safe local clone name/);
		expect(
			(
				await issueOf({
					kind: "template",
					slug: "template-booking",
					commit: "HEAD",
				})
			).message,
		).toMatch(/not a full commit sha/);
	});

	it("reads owner and repo from a normalized URL only", () => {
		expect(ownerRepo("https://github.com/acme/app")).toEqual({
			owner: "acme",
			repo: "app",
		});
		expect(ownerRepo("https://github.com/acme/app.git")).toEqual({
			owner: "acme",
			repo: "app",
		});
		for (const url of [
			"not a url",
			"https://github.com/acme",
			"https://github.com/acme/app/tree/main",
			"https://github.com/acme/..",
			"https://github.com/acme/%2e%2e",
		]) {
			expect(ownerRepo(url), url).toBeNull();
		}
	});
});

describe("the exit checkpoint", () => {
	const repo = fresh("repo");
	const [commit] = makeRepo(repo, FILES) as [string];
	const rooms = worktreeRooms(fresh("rooms-root"));
	let k = 100;
	const openRoom = async (globs: string[]) => {
		k += 1;
		return rooms.open({
			dispatchId: id(k),
			repoPath: repo,
			commit,
			writableGlobs: globs,
		});
	};

	it("lists nothing for an untouched room", async () => {
		const room = await openRoom(["src/**"]);
		expect(await changedFiles(room.root, commit)).toEqual([]);
	});

	it("lists every change kind from the pinned commit, untracked and ignored included, sorted by path", async () => {
		const room = await openRoom(["src/**"]);
		const at = (rel: string) => path.join(room.root, ...rel.split("/"));
		writeFileSync(at("src/a.ts"), "export const a = 99;\n");
		unlinkSync(at("docs/readme.md"));
		renameSync(at("src/b.ts"), at("src/renamed.ts"));
		writeFiles(room.root, {
			"src/new.ts": "new\n",
			"debug.log": "ignored, still seen\n",
		});
		const changes = await changedFiles(room.root, commit);
		expect(changes).toEqual([
			{ kind: "added", path: "debug.log" },
			{ kind: "deleted", path: "docs/readme.md" },
			{ kind: "modified", path: "src/a.ts" },
			{ kind: "added", path: "src/new.ts" },
			{ kind: "renamed", from: "src/b.ts", path: "src/renamed.ts" },
		]);
		// The room's own index is untouched: nothing is staged there.
		expect(gitIn(room.root, "diff", "--cached", "--name-only")).toBe("");
	});

	it("does not see a line-ending-only difference as a change", async () => {
		const room = await openRoom(["src/**"]);
		const raw = readFileSync(path.join(room.root, "src", "a.ts"), "utf8");
		expect(raw).not.toContain("\r");
		expect(await changedFiles(room.root, commit)).toEqual([]);
	});

	it("passes work inside the globs and returns the changed files", async () => {
		const room = await openRoom(["src/**"]);
		writeFiles(room.root, { "src/a.ts": "changed\n" });
		await expect(
			exitCheckpoint({ ...room, dispatchId: room.dispatchId }),
		).resolves.toEqual([{ kind: "modified", path: "src/a.ts" }]);
	});

	it("refuses work outside the globs (writes_outside_mount), every kind, rename at both paths", async () => {
		const room = await openRoom(["src/**"]);
		const at = (rel: string) => path.join(room.root, ...rel.split("/"));
		writeFiles(room.root, { "tests/a.test.ts": "changed\n", "x.ts": "new\n" });
		unlinkSync(at("docs/readme.md"));
		// Moved out of the mount: the new path is outside.
		renameSync(at("src/b.ts"), at("b.ts"));
		const err = await exitCheckpoint(room).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).details).toEqual({
			reason: "writes_outside_mount",
			dispatchId: room.dispatchId,
			issues: [
				{
					path: ["files", 0],
					message: "b.ts (renamed) is outside the writable paths",
				},
				{
					path: ["files", 1],
					message: "docs/readme.md (deleted) is outside the writable paths",
				},
				{
					path: ["files", 2],
					message: "tests/a.test.ts (modified) is outside the writable paths",
				},
				{
					path: ["files", 3],
					message: "x.ts (added) is outside the writable paths",
				},
			],
		});
	});

	it("checks both paths of a rename, old before new", () => {
		const changes = [
			{ kind: "renamed" as const, from: "docs/a.md", path: "notes/a.md" },
			{ kind: "renamed" as const, from: "docs/b.md", path: "src/b.md" },
			{ kind: "renamed" as const, from: "src/c.md", path: "docs/c.md" },
		];
		expect(checkpointIssues(changes, ["src/**"])).toEqual([
			{
				path: ["files", 0],
				message: "docs/a.md (renamed) is outside the writable paths",
			},
			{
				path: ["files", 0],
				message: "notes/a.md (renamed) is outside the writable paths",
			},
			{
				path: ["files", 1],
				message: "docs/b.md (renamed) is outside the writable paths",
			},
			{
				path: ["files", 2],
				message: "docs/c.md (renamed) is outside the writable paths",
			},
		]);
	});

	it("parses git's -z name-status, type changes as modified", () => {
		expect(
			parseNameStatus(
				"M\0b.ts\0T\0a.ts\0R087\0old.ts\0new.ts\0D\0c.ts\0A\0d.ts\0",
			),
		).toEqual([
			{ kind: "modified", path: "a.ts" },
			{ kind: "modified", path: "b.ts" },
			{ kind: "deleted", path: "c.ts" },
			{ kind: "added", path: "d.ts" },
			{ kind: "renamed", from: "old.ts", path: "new.ts" },
		]);
		expect(() => parseNameStatus("X\0a\0")).toThrow(/unexpected git status/);
	});
});
