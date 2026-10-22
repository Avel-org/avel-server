import { execFile, spawn } from "node:child_process";

/**
 * Runs git with an argument array through execFile, never a shell string,
 * so no path or sha is ever parsed by a shell. Every call pins
 * core.autocrlf=false, so a room holds the commit's own bytes on every
 * platform and a status read never sees line endings as changes.
 */
export function git(
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
			{
				cwd: options.cwd,
				env: options.env ?? process.env,
				maxBuffer: 64 * 1024 * 1024,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(`git ${args[0] ?? ""} failed: ${String(stderr).trim()}`, {
							cause: err,
						}),
					);
					return;
				}
				resolve(String(stdout));
			},
		);
	});
}

/** Whether `git` succeeds, for checks that answer yes or no. */
export async function gitOk(
	args: readonly string[],
	options: { cwd?: string } = {},
): Promise<boolean> {
	try {
		await git(args, options);
		return true;
	} catch {
		return false;
	}
}

/** A full commit sha: 40 lowercase hex. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Bytes git looks at to call a blob binary: a NUL in them means binary. */
export const BINARY_SNIFF_BYTES = 8000;

/** A blob as readBlobs reads it: whole up to the limit, else its first bytes only. */
export type BlobRead = { size: number; bytes: Uint8Array; whole: boolean };

/**
 * Blobs' exact bytes, in two git processes however many there are. Sizes
 * come first (`cat-file --batch-check`), so a blob over `limit` is never
 * read whole: only its first BINARY_SNIFF_BYTES, which is enough to tell a
 * binary file from text. Blobs up to `limit` come whole from one
 * `cat-file --batch`. git() decodes stdout as text, which would change
 * binary files, so these read raw bytes.
 */
export async function readBlobs(
	source: string,
	shas: readonly string[],
	limit: number,
): Promise<Map<string, BlobRead>> {
	const unique = [...new Set(shas)];
	const out = new Map<string, BlobRead>();
	if (unique.length === 0) return out;
	const checked = (
		await gitRaw(source, ["cat-file", "--batch-check"], unique)
	).toString("latin1");
	const sizes = new Map<string, number>();
	for (const line of checked.split("\n")) {
		if (line === "") continue;
		const [sha, type, size] = line.split(" ");
		if (type !== "blob" || !sha || size === undefined) {
			throw new Error(`git cat-file --batch-check: ${line}`);
		}
		sizes.set(sha, Number(size));
	}
	const small = unique.filter((sha) => (sizes.get(sha) ?? 0) <= limit);
	if (small.length > 0) {
		const batch = await gitRaw(source, ["cat-file", "--batch"], small);
		let at = 0;
		for (const sha of small) {
			const eol = batch.indexOf(10, at);
			const [got, , size] = batch
				.subarray(at, eol)
				.toString("latin1")
				.split(" ");
			const n = Number(size);
			if (got !== sha || !Number.isInteger(n)) {
				throw new Error(`git cat-file --batch gave ${got} for ${sha}`);
			}
			const start = eol + 1;
			out.set(sha, {
				size: n,
				bytes: batch.subarray(start, start + n),
				whole: true,
			});
			at = start + n + 1;
		}
	}
	for (const sha of unique) {
		if (out.has(sha)) continue;
		const bytes = await gitRaw(
			source,
			["cat-file", "blob", sha],
			[],
			BINARY_SNIFF_BYTES,
		);
		out.set(sha, {
			size: sizes.get(sha) as number,
			bytes: bytes.subarray(0, BINARY_SNIFF_BYTES),
			whole: false,
		});
	}
	return out;
}

/**
 * git with stdin lines and raw stdout. With `stopAfter`, it stops reading
 * and ends git once that many bytes have arrived.
 */
function gitRaw(
	cwd: string,
	args: readonly string[],
	stdin: readonly string[],
	stopAfter?: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"git",
			["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
			{ cwd, windowsHide: true },
		);
		const chunks: Buffer[] = [];
		const errs: Buffer[] = [];
		let got = 0;
		let stopped = false;
		child.stdout.on("data", (c: Buffer) => {
			if (stopped) return;
			chunks.push(c);
			got += c.length;
			if (stopAfter !== undefined && got >= stopAfter) {
				stopped = true;
				child.kill();
				resolve(Buffer.concat(chunks));
			}
		});
		child.stderr.on("data", (c: Buffer) => errs.push(c));
		child.on("error", (e) => {
			if (!stopped) reject(e);
		});
		child.on("close", (code) => {
			if (stopped) return;
			if (code !== 0) {
				reject(
					new Error(
						`git ${args[0] ?? ""} failed: ${Buffer.concat(errs).toString("utf8").trim()}`,
					),
				);
				return;
			}
			resolve(Buffer.concat(chunks));
		});
		// A killed or failed git may close stdin first; its exit code reports that.
		child.stdin.on("error", () => {});
		child.stdin.end(stdin.map((l) => `${l}\n`).join(""));
	});
}
