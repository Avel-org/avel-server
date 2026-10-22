import { execFile } from "node:child_process";

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

/** A blob's exact bytes. git() decodes stdout as text, which would change binary files. */
export function readBlob(source: string, blobSha: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["cat-file", "blob", blobSha],
			{
				cwd: source,
				encoding: "buffer",
				maxBuffer: 64 * 1024 * 1024,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(`git cat-file failed: ${String(stderr).trim()}`, {
							cause: err,
						}),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}
