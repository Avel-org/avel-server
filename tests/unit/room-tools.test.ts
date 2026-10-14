import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	editTool,
	isGitSegment,
	listTool,
	normalizeRoomPath,
	readTool,
	type ToolRefusal,
	type ToolRoom,
	writeTool,
} from "../../src/rooms/tools";
import { removeDir, tempDir, writeFiles } from "./git-fixtures";

const base = tempDir("tools");
afterAll(() => removeDir(base));

let n = 0;
let room: ToolRoom;
let outside: string;

beforeEach(() => {
	n += 1;
	const root = path.join(base, `room-${n}`);
	outside = path.join(base, `outside-${n}`);
	writeFiles(root, {
		"src/a.ts": "export const a = 1;\n",
		"src/twice.ts": "x x\n",
		"docs/readme.md": "# Readme\n",
		".git/config": "[core]\n",
	});
	writeFiles(outside, { "secret.txt": "secret\n" });
	room = { root, writableGlobs: ["src/**"] };
});

async function refused(p: Promise<unknown>, refusal: ToolRefusal) {
	await expect(p).rejects.toMatchObject({ name: "ToolError", refusal });
}

const onDisk = (rel: string) =>
	readFileSync(path.join(room.root, ...rel.split("/")), "utf8");

/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkDir(target: string, at: string) {
	symlinkSync(target, at, "junction");
}

describe("normalizeRoomPath", () => {
	it("joins segments with /, from / or \\, dropping . and empty ones", () => {
		expect(normalizeRoomPath("src\\a.ts")).toBe("src/a.ts");
		expect(normalizeRoomPath("./src//a.ts")).toBe("src/a.ts");
		expect(normalizeRoomPath("")).toBe("");
		expect(normalizeRoomPath(".")).toBe("");
	});

	it("refuses absolute paths, drive paths, UNC paths and NUL", () => {
		for (const p of [
			"/etc/passwd",
			"C:\\Windows\\win.ini",
			"c:relative",
			"\\\\server\\share\\x",
			"src/a\0.ts",
		]) {
			expect(() => normalizeRoomPath(p), p).toThrow(
				expect.objectContaining({ refusal: "path_invalid" }),
			);
		}
	});

	it("refuses .. anywhere, even when it would land back inside", () => {
		for (const p of ["../x", "src/../../x", "src/../src/a.ts", "src\\..\\a"]) {
			expect(() => normalizeRoomPath(p), p).toThrow(
				expect.objectContaining({ refusal: "path_invalid" }),
			);
		}
	});

	it("refuses .git as any segment, in any case", () => {
		for (const p of [
			".git",
			".git/config",
			"src/.git/x",
			".GIT/HEAD",
			".Git",
		]) {
			expect(() => normalizeRoomPath(p), p).toThrow(
				expect.objectContaining({ refusal: "git_dir" }),
			);
		}
	});

	it("reads .git however Windows would spell it, as the second line of defence", () => {
		for (const s of [".git", ".GIT", ".git.", ".git ", ".Git. .", ".git..  "]) {
			expect(isGitSegment(s), JSON.stringify(s)).toBe(true);
		}
		for (const s of ["git", ".gitignore", ".git2", "x.git", ".git.x"]) {
			expect(isGitSegment(s), s).toBe(false);
		}
	});

	it("refuses a trailing dot or space, which Windows strips (.git. is .git)", () => {
		for (const p of [
			".git.",
			".git ",
			".GIT..",
			"src/a.ts.",
			"src/a.ts ",
			"src. /a.ts",
		]) {
			expect(() => normalizeRoomPath(p), JSON.stringify(p)).toThrow(
				expect.objectContaining({ refusal: "path_invalid" }),
			);
		}
	});

	it("refuses a colon, which names an alternate data stream git never sees", () => {
		for (const p of [
			"src/a.ts:hidden",
			"src/a.ts::$DATA",
			"src:x/a.ts",
			"a:b",
		]) {
			expect(() => normalizeRoomPath(p), p).toThrow(
				expect.objectContaining({ refusal: "path_invalid" }),
			);
		}
	});

	it("refuses device names in any case, with or without an extension", () => {
		for (const p of [
			"CON",
			"prn",
			"src/Aux",
			"nul.txt",
			"src/NUL.tar.gz",
			"com1",
			"COM9.log",
			"lpt1",
			"src/Lpt9.md",
		]) {
			expect(() => normalizeRoomPath(p), p).toThrow(
				expect.objectContaining({ refusal: "path_invalid" }),
			);
		}
		// Names that only look like them are fine.
		for (const p of [
			"console.ts",
			"src/com10.ts",
			"lpt.md",
			"src/nullable.ts",
			"com0",
		]) {
			expect(normalizeRoomPath(p), p).toBe(p);
		}
	});
});

describe("readTool", () => {
	it("reads any file in the room, writable or not", async () => {
		expect(await readTool(room, "src/a.ts")).toBe("export const a = 1;\n");
		expect(await readTool(room, "docs\\readme.md")).toBe("# Readme\n");
	});

	it("refuses .git, traversal, absolute paths, missing files and directories", async () => {
		await refused(readTool(room, ".git/config"), "git_dir");
		await refused(readTool(room, "../outside/secret.txt"), "path_invalid");
		await refused(
			readTool(room, path.join(outside, "secret.txt")),
			"path_invalid",
		);
		await refused(readTool(room, "src/missing.ts"), "not_found");
		await refused(readTool(room, "src"), "not_a_file");
	});

	it("refuses a path through a junction or symlink that leads outside", async () => {
		linkDir(outside, path.join(room.root, "src", "escape"));
		await refused(readTool(room, "src/escape/secret.txt"), "outside_room");
		await refused(listTool(room, "src/escape"), "outside_room");
	});

	it("follows a link that stays inside the room", async () => {
		linkDir(path.join(room.root, "docs"), path.join(room.root, "src", "docs"));
		expect(await readTool(room, "src/docs/readme.md")).toBe("# Readme\n");
	});
});

describe("listTool", () => {
	it("lists one directory by name, without .git", async () => {
		expect(await listTool(room)).toEqual([
			{ name: "docs", kind: "directory" },
			{ name: "src", kind: "directory" },
		]);
		expect(await listTool(room, "src")).toEqual([
			{ name: "a.ts", kind: "file" },
			{ name: "twice.ts", kind: "file" },
		]);
	});

	it("refuses a file, a missing directory and .git", async () => {
		await refused(listTool(room, "src/a.ts"), "not_a_directory");
		await refused(listTool(room, "nope"), "not_found");
		await refused(listTool(room, ".git"), "git_dir");
	});
});

describe("writeTool", () => {
	it("writes inside the writable globs, making directories", async () => {
		await writeTool(room, "src/new/deep.ts", "deep\n");
		expect(onDisk("src/new/deep.ts")).toBe("deep\n");
		await writeTool(room, "src/a.ts", "replaced\n");
		expect(onDisk("src/a.ts")).toBe("replaced\n");
	});

	it("refuses outside the writable globs, and writes nothing", async () => {
		await refused(writeTool(room, "docs/readme.md", "x"), "outside_mount");
		await refused(writeTool(room, "new.ts", "x"), "outside_mount");
		await refused(writeTool(room, "srcx/a.ts", "x"), "outside_mount");
		await refused(writeTool(room, "", "x"), "outside_mount");
		expect(onDisk("docs/readme.md")).toBe("# Readme\n");
		expect(existsSync(path.join(room.root, "new.ts"))).toBe(false);
		expect(existsSync(path.join(room.root, "srcx"))).toBe(false);
	});

	it("refuses .git and traversal even when a glob would allow it", async () => {
		const open: ToolRoom = { root: room.root, writableGlobs: ["**"] };
		await refused(writeTool(open, ".git/hooks/pre-commit", "x"), "git_dir");
		await refused(writeTool(open, "../outside/x.txt", "x"), "path_invalid");
		// The room root itself is never a file to write, whatever the glob.
		await refused(writeTool(open, "", "x"), "outside_mount");
		expect(onDisk(".git/config")).toBe("[core]\n");
	});

	it("refuses to write through a link that leads outside", async () => {
		linkDir(outside, path.join(room.root, "src", "escape"));
		await refused(
			writeTool(room, "src/escape/secret.txt", "x"),
			"outside_room",
		);
		await refused(writeTool(room, "src/escape/new/x.txt", "x"), "outside_room");
		expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(
			"secret\n",
		);
		expect(existsSync(path.join(outside, "new"))).toBe(false);
	});
});

describe("editTool", () => {
	it("replaces exactly one occurrence", async () => {
		await editTool(room, "src/a.ts", "= 1", "= 2");
		expect(onDisk("src/a.ts")).toBe("export const a = 2;\n");
	});

	it("refuses no match, an empty match, and more than one, writing nothing", async () => {
		await refused(editTool(room, "src/a.ts", "= 9", "= 2"), "no_match");
		await refused(editTool(room, "src/a.ts", "", "x"), "no_match");
		await refused(editTool(room, "src/twice.ts", "x", "y"), "multiple_matches");
		expect(onDisk("src/a.ts")).toBe("export const a = 1;\n");
		expect(onDisk("src/twice.ts")).toBe("x x\n");
	});

	it("counts an overlapping second match as more than one", async () => {
		writeFiles(room.root, { "src/aaa.ts": "aaa\n" });
		await refused(editTool(room, "src/aaa.ts", "aa", "b"), "multiple_matches");
		expect(onDisk("src/aaa.ts")).toBe("aaa\n");
	});

	it("refuses outside the writable globs and missing files", async () => {
		await refused(editTool(room, "docs/readme.md", "#", "##"), "outside_mount");
		await refused(editTool(room, "src/missing.ts", "a", "b"), "not_found");
		expect(onDisk("docs/readme.md")).toBe("# Readme\n");
	});

	it("refuses to edit through a link that leads outside", async () => {
		mkdirSync(path.join(room.root, "src", "x"), { recursive: true });
		linkDir(outside, path.join(room.root, "src", "x", "escape"));
		await refused(
			editTool(room, "src/x/escape/secret.txt", "secret", "stolen"),
			"outside_room",
		);
		expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(
			"secret\n",
		);
	});
});
