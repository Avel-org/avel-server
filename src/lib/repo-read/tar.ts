import { gunzipSync } from "node:zlib";
import {
	LIMITS,
	type Limits,
	type Snapshot,
	SnapshotBuilder,
	tooLarge,
} from "./snapshot";

const BLOCK = 512;

function field(header: Uint8Array, start: number, length: number): string {
	const bytes = header.subarray(start, start + length);
	const end = bytes.indexOf(0);
	return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(header: Uint8Array, start: number, length: number): number {
	const text = field(header, start, length).trim();
	const n = Number.parseInt(text === "" ? "0" : text, 8);
	if (!Number.isFinite(n) || n < 0) throw new Error("tar: bad size field");
	return n;
}

/** The records of a pax extended header ("<len> key=value\n" ...). */
function paxRecords(body: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	const text = new TextDecoder().decode(body);
	let i = 0;
	while (i < text.length) {
		const space = text.indexOf(" ", i);
		if (space === -1) break;
		const length = Number.parseInt(text.slice(i, space), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = text.slice(space + 1, i + length - 1);
		const eq = record.indexOf("=");
		if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
		i += length;
	}
	return records;
}

/**
 * A GitHub tarball (gzipped ustar with pax headers) as a Snapshot. GitHub
 * wraps every file in one top-level directory (owner-repo-sha/), which is
 * stripped. Directories, links and other special entries are skipped.
 * Exceeding a limit is TREE_TOO_LARGE, checked while decompressing too, so a
 * small archive cannot expand without bound.
 */
export function snapshotFromTarball(
	gzipped: Uint8Array,
	commitSha: string,
	limits: Limits = LIMITS,
): Snapshot {
	let tar: Uint8Array;
	try {
		// Each file costs at least one 512-byte header and pads to 512.
		tar = gunzipSync(gzipped, {
			maxOutputLength: limits.bytes + limits.entries * BLOCK * 3,
		});
	} catch (e) {
		if (e instanceof RangeError) throw tooLarge("the archive expands too far");
		throw e;
	}
	const builder = new SnapshotBuilder(limits);
	let offset = 0;
	let nextPath: string | undefined;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((b) => b === 0)) break;
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 0);
		const bodyStart = offset + BLOCK;
		const body = tar.subarray(bodyStart, bodyStart + size);
		offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "x") {
			nextPath = paxRecords(body).get("path") ?? nextPath;
			continue;
		}
		if (type === "L") {
			nextPath = field(body, 0, body.length);
			continue;
		}
		if (type === "g") continue;
		const name = field(header, 0, 100);
		const prefix = field(header, 345, 155);
		const full = nextPath ?? (prefix ? `${prefix}/${name}` : name);
		nextPath = undefined;
		if (type !== "0" && type !== "\0") continue;
		const slash = full.indexOf("/");
		const path = slash === -1 ? full : full.slice(slash + 1);
		if (path === "") continue;
		builder.add(path, body);
	}
	return builder.build(commitSha);
}
