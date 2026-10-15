import {
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { writable } from "./globs";

/**
 * The agent's file tools in a Tier 0 room (module 7): read, write, edit and
 * list, nothing else. No shell, no installs, no network. The runner calls
 * them on the agent's behalf over its local channel; no HTTP route reaches
 * them, and the agent's token never enters the room (SANDBOX.md).
 *
 * Every path is relative to the room's root, written with / or \. It is
 * refused when absolute, when any segment is `..` or `.git` (any case),
 * or when it resolves, through a symlink or junction, outside the room.
 * Write and edit are refused outside the writable globs. That write check
 * is the tool's own [attestation]-grade guard, not a mount: the exit
 * checkpoint (checkpoint.ts) is what refuses the work if anything got past.
 */

export type ToolRoom = {
	/** The room's root directory, absolute. */
	root: string;
	/** The roster entry's resolved writable globs. */
	writableGlobs: readonly string[];
};

export const TOOL_REFUSALS = [
	"path_invalid",
	"outside_room",
	"git_dir",
	"outside_mount",
	"not_found",
	"not_a_file",
	"not_a_directory",
	"no_match",
	"multiple_matches",
] as const;

export type ToolRefusal = (typeof TOOL_REFUSALS)[number];

/** A refused tool call. The runner reports it to the agent; nothing is written. */
export class ToolError extends Error {
	readonly refusal: ToolRefusal;
	readonly path: string;
	constructor(refusal: ToolRefusal, toolPath: string, message: string) {
		super(message);
		this.name = "ToolError";
		this.refusal = refusal;
		this.path = toolPath;
	}
}

/**
 * A tool path as room segments joined by /, or a refusal. Pure. `.` and
 * empty segments collapse; the room root itself is the empty string.
 */
export function normalizeRoomPath(input: string): string {
	if (
		input.includes("\0") ||
		// win32's rule also covers /x and \x, and UNC \\server paths.
		path.win32.isAbsolute(input) ||
		/^[A-Za-z]:/.test(input)
	) {
		throw new ToolError("path_invalid", input, `${input} is not a room path`);
	}
	const segments = input.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
	if (segments.includes("..")) {
		throw new ToolError("path_invalid", input, `${input} leaves the room`);
	}
	const alias = segments.find(windowsAlias);
	if (alias !== undefined) {
		throw new ToolError(
			"path_invalid",
			input,
			`${input} has a segment Windows would read as another name: ${alias}`,
		);
	}
	if (segments.some(isGitSegment)) {
		throw new ToolError("git_dir", input, `${input} is inside .git`);
	}
	return segments.join("/");
}

/**
 * Whether a segment names .git however Windows would read it: any case,
 * trailing dots and spaces stripped. The alias check above refuses those
 * spellings first; this is the second line of defence.
 */
export function isGitSegment(segment: string): boolean {
	return segment.replace(/[. ]+$/, "").toLowerCase() === ".git";
}

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9: devices, in any case, with any extension. */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A segment Win32 would not take literally, refused on every platform:
 * a trailing dot or space (stripped, so `.git.` is `.git`), a colon (an
 * NTFS alternate data stream, which git never sees), or a device name.
 */
function windowsAlias(segment: string): boolean {
	return /[. ]$/.test(segment) || segment.includes(":") || DEVICE.test(segment);
}

function within(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * The real location of a room path: realpath of the path when it exists,
 * else of its nearest existing ancestor, which must be inside the room's
 * own realpath. Catches a symlink or junction anywhere on the way.
 */
async function resolveInRoom(room: ToolRoom, rel: string): Promise<string> {
	const root = await realpath(room.root);
	const target = path.join(root, ...rel.split("/").filter(Boolean));
	let probe = target;
	for (;;) {
		try {
			const real = await realpath(probe);
			if (!within(root, real)) {
				throw new ToolError(
					"outside_room",
					rel,
					`${rel} resolves outside the room`,
				);
			}
			return target;
		} catch (err) {
			if (!isMissing(err)) throw err;
			const parent = path.dirname(probe);
			if (parent === probe) throw err;
			probe = parent;
		}
	}
}

function requireWritable(room: ToolRoom, rel: string): void {
	if (rel === "" || !writable(rel, room.writableGlobs)) {
		throw new ToolError(
			"outside_mount",
			rel,
			`${rel} is outside the writable paths ${room.writableGlobs.join(", ")}`,
		);
	}
}

async function fileAt(room: ToolRoom, rel: string): Promise<string> {
	const target = await resolveInRoom(room, rel);
	try {
		if (!(await stat(target)).isFile()) {
			throw new ToolError("not_a_file", rel, `${rel} is not a file`);
		}
	} catch (err) {
		if (isMissing(err)) {
			throw new ToolError("not_found", rel, `${rel} does not exist`);
		}
		throw err;
	}
	return target;
}

/** A file's text, as UTF-8. Anywhere in the room but .git. */
export async function readTool(room: ToolRoom, input: string): Promise<string> {
	const rel = normalizeRoomPath(input);
	return readFile(await fileAt(room, rel), "utf8");
}

/** A file's bytes, under readTool's rules: what an artifact's sha256 covers. */
export async function readBytesTool(
	room: ToolRoom,
	input: string,
): Promise<Buffer> {
	const rel = normalizeRoomPath(input);
	return readFile(await fileAt(room, rel));
}

export type ListEntry = { name: string; kind: "file" | "directory" };

/** One directory's entries, by name in code-unit order, without .git. */
export async function listTool(
	room: ToolRoom,
	input = "",
): Promise<ListEntry[]> {
	const rel = normalizeRoomPath(input);
	const target = await resolveInRoom(room, rel);
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") {
			throw new ToolError("not_found", rel, `${rel} does not exist`);
		}
		if (code === "ENOTDIR") {
			throw new ToolError("not_a_directory", rel, `${rel} is not a directory`);
		}
		throw err;
	}
	return entries
		.filter((e) => !isGitSegment(e.name))
		.map(
			(e): ListEntry => ({
				name: e.name,
				kind: e.isDirectory() ? "directory" : "file",
			}),
		)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Writes a whole file, creating its directories. Only inside the writable globs. */
export async function writeTool(
	room: ToolRoom,
	input: string,
	content: string,
): Promise<void> {
	const rel = normalizeRoomPath(input);
	requireWritable(room, rel);
	const target = await resolveInRoom(room, rel);
	await mkdir(path.dirname(target), { recursive: true });
	// resolveInRoom checked the nearest existing ancestor; the directories
	// mkdir adds below it are plain directories, so the check still holds.
	await writeFile(target, content, "utf8");
}

/**
 * Replaces exactly one occurrence of `oldText` with `newText`. None, or
 * more than one, refuses and writes nothing. Only inside the writable globs.
 */
export async function editTool(
	room: ToolRoom,
	input: string,
	oldText: string,
	newText: string,
): Promise<void> {
	const rel = normalizeRoomPath(input);
	requireWritable(room, rel);
	const target = await fileAt(room, rel);
	const text = await readFile(target, "utf8");
	const first = oldText === "" ? -1 : text.indexOf(oldText);
	if (first === -1) {
		throw new ToolError("no_match", rel, `${rel} does not contain the text`);
	}
	// From first + 1, so an overlapping second match ("aa" in "aaa") counts.
	if (text.indexOf(oldText, first + 1) !== -1) {
		throw new ToolError(
			"multiple_matches",
			rel,
			`${rel} contains the text more than once`,
		);
	}
	await writeFile(
		target,
		text.slice(0, first) + newText + text.slice(first + oldText.length),
		"utf8",
	);
}
