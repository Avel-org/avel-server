import { execFile } from "node:child_process";
import { COMMIT_SHA } from "../../rooms/git";
import { gitBlobSha } from "./blob";
import { byCodepoint } from "./order";
import { refuse } from "./refusal";

/** A file mode render keeps: a regular file, or an executable one. */
export type PackageMode = "100644" | "100755";

export type PackageFile = {
	path: string;
	mode: PackageMode;
	bytes: Uint8Array;
	blobSha: string;
};

/** What the integration commit changed from the base, as files and deletes. */
export type PackageRead = { files: PackageFile[]; deletes: string[] };

const MODES: readonly string[] = ["100644", "100755"];
const SYMLINK = "120000";
const GITLINK = "160000";
const ABSENT = "000000";

/**
 * Runs git with an argument array, as src/rooms/git.ts does, and returns
 * stdout as bytes, never decoded, so a blob arrives exactly as git holds it.
 */
function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
			{
				cwd,
				encoding: "buffer",
				maxBuffer: 256 * 1024 * 1024,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(
							`git ${args[0] ?? ""} failed: ${stderr.toString("utf8").trim()}`,
							{ cause: err },
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** One entry of `git diff-tree -r -z` raw output. */
type RawChange = {
	srcMode: string;
	dstMode: string;
	srcSha: string;
	dstSha: string;
	status: string;
	path: string;
};

/**
 * Raw diff-tree output with -z: for each change, ":<src mode> <dst mode>
 * <src sha> <dst sha> <status>" and the path, each ended by NUL. Without
 * rename or copy detection there is one path per change. The bytes are
 * split on NUL before decoding, so a path that is not UTF-8 is refused by
 * name instead of being decoded into another path.
 */
function parseRaw(out: Buffer): RawChange[] {
	const parts: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < out.length; i++) {
		if (out[i] === 0) {
			parts.push(out.subarray(start, i));
			start = i + 1;
		}
	}
	const changes: RawChange[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const head = (parts[i] as Buffer).toString("latin1");
		const raw = parts[i + 1] as Buffer;
		const [srcMode, dstMode, srcSha, dstSha, status] = head
			.replace(/^:/, "")
			.split(" ");
		if (!srcMode || !dstMode || !srcSha || !dstSha || !status) {
			throw new Error(`diff-tree gave an entry out of format: ${head}`);
		}
		let path: string;
		try {
			path = utf8.decode(raw);
		} catch {
			throw refuse("A changed path is not UTF-8", {
				reason: "path_not_utf8",
				path: raw.toString("latin1"),
			});
		}
		changes.push({ srcMode, dstMode, srcSha, dstSha, status, path });
	}
	return changes;
}

/**
 * Every path the commit changed from the base, read from the git clone at
 * `source`: each written file with its mode, bytes and blob sha, and each
 * deleted path, both sorted by codepoint. The diff is git's, with rename
 * detection off, so a rename is a delete and a write.
 *
 * Bytes come from `git cat-file blob`, which applies no filter and no
 * line-ending conversion, and each is checked against the blob sha the diff
 * named. A symlink or submodule on either side of a change, a change of mode
 * alone, or a mode other than 100644 and 100755 is refused (ExportRefused)
 * with the path.
 */
export async function readPackage(
	source: string,
	baseSha: string,
	commitSha: string,
): Promise<PackageRead> {
	if (!COMMIT_SHA.test(baseSha)) {
		throw new Error(`The base ${baseSha} is not a full commit sha`);
	}
	if (!COMMIT_SHA.test(commitSha)) {
		throw new Error(`The commit ${commitSha} is not a full commit sha`);
	}
	const out = await gitBytes(source, [
		"diff-tree",
		"-r",
		"-z",
		"--no-renames",
		"--no-ext-diff",
		"--no-textconv",
		baseSha,
		commitSha,
	]);

	const files: PackageFile[] = [];
	const deletes: string[] = [];
	for (const c of parseRaw(out)) {
		for (const mode of [c.srcMode, c.dstMode]) {
			if (mode === SYMLINK) {
				throw refuse("A changed path is a symlink", {
					reason: "symlink",
					path: c.path,
				});
			}
			if (mode === GITLINK) {
				throw refuse("A changed path is a submodule", {
					reason: "submodule",
					path: c.path,
				});
			}
			if (mode !== ABSENT && !MODES.includes(mode)) {
				throw refuse(`A changed path has mode ${mode}`, {
					reason: "unsupported_mode",
					path: c.path,
					mode,
				});
			}
		}
		if (c.dstMode === ABSENT) {
			deletes.push(c.path);
			continue;
		}
		if (c.srcMode !== ABSENT && c.srcSha === c.dstSha) {
			throw refuse("A path changed its mode and nothing else", {
				reason: "mode_only",
				path: c.path,
				from: c.srcMode,
				to: c.dstMode,
			});
		}
		const bytes = new Uint8Array(
			await gitBytes(source, ["cat-file", "blob", c.dstSha]),
		);
		if (gitBlobSha(bytes) !== c.dstSha) {
			throw new Error(`cat-file gave other bytes for ${c.path}`);
		}
		files.push({
			path: c.path,
			mode: c.dstMode as PackageMode,
			bytes,
			blobSha: c.dstSha,
		});
	}
	files.sort((a, b) => byCodepoint(a.path, b.path));
	deletes.sort(byCodepoint);
	return { files, deletes };
}
