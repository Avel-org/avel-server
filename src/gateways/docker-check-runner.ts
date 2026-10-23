import { spawn } from "node:child_process";
import type { IdGenerator } from "../lib/ids";
import { git } from "../rooms/git";
import type {
	CheckRunner,
	CheckRunRequest,
	CheckRunResult,
} from "./check-runner";

/** An image named by its digest, so every run uses the same bytes. */
export const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** Where the commit is unpacked. Under /tmp, so `node` owns it without a chown. */
const WORK = "/tmp/work";

export type DockerCheckRunnerOptions = {
	/** The image the checks run in, pinned by digest (AVEL_CHECK_IMAGE). */
	image: string;
	/** Names each run's container. */
	ids: IdGenerator;
	/** Per check. Default 10 minutes. */
	checkTimeoutMs?: number;
	/** For the install. Default 10 minutes. */
	installTimeoutMs?: number;
	/** How much of a command's output is kept, from its end. Default 64 KiB. */
	outputBytes?: number;
	memory?: string;
	cpus?: string;
	pids?: number;
};

type Exec = { code: number | null; output: string };

/**
 * The gate's check runner on local Docker (decided 2026-10-22), under
 * SANDBOX.md's running-room rules. Each run gets a new container, removed
 * afterwards:
 *
 * 1. The commit's files, from `git archive`, never a working tree, are
 *    unpacked into /tmp/work. Nothing from the host is mounted.
 * 2. The install runs with the network, and with `--ignore-scripts`, so the
 *    package manager is the only code that runs while the network is up.
 *    It needs a lockfile: pnpm-lock.yaml or package-lock.json. A
 *    package.json without one leaves every check an error. No package.json,
 *    no install.
 * 3. The container leaves its network before any check runs. A runner that
 *    cannot prove it left runs no check.
 * 4. Each check runs as the image's `node` user, with no capabilities, no
 *    new privileges, a memory, CPU and process cap, and a time limit. Exit
 *    0 passes, any other exit fails, and a check killed at its limit is an
 *    error.
 *
 * The container gets no host environment, so no credential reaches it.
 * Registry-only egress during the install is not built: the install's
 * network is the default bridge.
 */
export function dockerCheckRunner(opts: DockerCheckRunnerOptions): CheckRunner {
	if (!PINNED_IMAGE.test(opts.image)) {
		throw new Error(
			`The check image ${opts.image} is not pinned by digest (name@sha256:<64 hex>)`,
		);
	}
	const checkTimeoutMs = opts.checkTimeoutMs ?? 10 * 60_000;
	const installTimeoutMs = opts.installTimeoutMs ?? 10 * 60_000;
	const outputBytes = opts.outputBytes ?? 64 * 1024;
	const tail = (s: string) => {
		const b = Buffer.from(s, "utf8");
		return b.byteLength <= outputBytes
			? s
			: b.subarray(b.byteLength - outputBytes).toString("utf8");
	};

	return {
		id: `docker:${opts.image}`,
		async run(request: CheckRunRequest): Promise<CheckRunResult[]> {
			if (request.checks.length === 0) return [];
			const name = `avel-check-${opts.ids.next()}`;
			const created = await docker([
				"create",
				"--name",
				name,
				"--network",
				"bridge",
				"--user",
				"node",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--memory",
				opts.memory ?? "2g",
				"--cpus",
				opts.cpus ?? "2",
				"--pids-limit",
				String(opts.pids ?? 512),
				"--env",
				"CI=1",
				"--env",
				"HOME=/tmp/home",
				"--env",
				"COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
				opts.image,
				"sleep",
				"infinity",
			]);
			if (created.code !== 0) {
				throw new Error(`docker create failed: ${created.output.trim()}`);
			}
			try {
				await must(docker(["start", name]), "docker start");
				await must(
					docker(["exec", name, "mkdir", "-p", WORK, "/tmp/home"]),
					"preparing the work directory",
				);
				await unpack(request.source, request.commitSha, name);

				const install = await installCommand(request.source, request.commitSha);
				if (install.kind === "refused") {
					return request.checks.map(() => errored(install.why));
				}
				if (install.kind === "command") {
					const done = await inContainer(
						name,
						install.command,
						installTimeoutMs,
					);
					if (done.code !== 0) {
						return request.checks.map(() =>
							errored(`The install failed:\n${tail(done.output)}`),
						);
					}
				}

				await must(
					docker(["network", "disconnect", "--force", "bridge", name]),
					"leaving the network",
				);
				const networks = await must(
					docker([
						"inspect",
						"--format",
						"{{len .NetworkSettings.Networks}}",
						name,
					]),
					"reading the networks",
				);
				if (networks.trim() !== "0") {
					throw new Error(
						`The check container is still on ${networks.trim()} network(s)`,
					);
				}

				const results: CheckRunResult[] = [];
				for (const [i, check] of request.checks.entries()) {
					await request.onProgress?.(i, i);
					const r = await inContainer(name, check.command, checkTimeoutMs);
					// 124 is timeout's own exit, 137 a kill: either way it did not finish.
					results.push(
						r.code === null || r.code === 124 || r.code === 137
							? errored(tail(r.output))
							: {
									outcome: r.code === 0 ? "pass" : "fail",
									exitCode: r.code,
									output: tail(r.output),
								},
					);
				}
				await request.onProgress?.(results.length, null);
				return results;
			} finally {
				await docker(["rm", "--force", name]);
			}
		},
	};
}

const errored = (output: string): CheckRunResult => ({
	outcome: "error",
	exitCode: null,
	output,
});

async function must(p: Promise<Exec>, what: string): Promise<string> {
	const r = await p;
	if (r.code !== 0) throw new Error(`${what} failed: ${r.output.trim()}`);
	return r.output;
}

/** A command in the work directory, as `node`, killed at `ms`. */
function inContainer(name: string, command: string, ms: number) {
	const secs = Math.max(1, Math.ceil(ms / 1000));
	return docker(
		[
			"exec",
			"--workdir",
			WORK,
			name,
			"timeout",
			"-s",
			"KILL",
			String(secs),
			"sh",
			"-c",
			command,
		],
		// The host stops waiting a little after the container's own limit.
		{ timeoutMs: ms + 30_000 },
	);
}

/** What the install is, read from the commit's root, never from the container. */
async function installCommand(
	source: string,
	commitSha: string,
): Promise<
	| { kind: "none" }
	| { kind: "command"; command: string }
	| { kind: "refused"; why: string }
> {
	const root = new Set(
		(await git(["ls-tree", "--name-only", commitSha], { cwd: source }))
			.split("\n")
			.filter(Boolean),
	);
	if (root.has("pnpm-lock.yaml")) {
		return {
			kind: "command",
			command: "corepack pnpm install --frozen-lockfile --ignore-scripts",
		};
	}
	if (root.has("package-lock.json")) {
		return { kind: "command", command: "npm ci --ignore-scripts" };
	}
	if (root.has("package.json")) {
		return {
			kind: "refused",
			why: "The commit has a package.json and no lockfile (pnpm-lock.yaml or package-lock.json), so nothing can be installed reproducibly",
		};
	}
	return { kind: "none" };
}

/** `git archive` of the commit, unpacked into the work directory inside the container. */
function unpack(source: string, commitSha: string, name: string) {
	return new Promise<void>((resolve, reject) => {
		const archive = spawn(
			"git",
			["-c", "core.autocrlf=false", "archive", "--format=tar", commitSha],
			{ cwd: source, windowsHide: true },
		);
		const extract = spawn(
			"docker",
			["exec", "-i", "--workdir", WORK, name, "tar", "-x", "-f", "-"],
			{ windowsHide: true },
		);
		let err = "";
		archive.stderr.on("data", (d) => {
			err += String(d);
		});
		extract.stderr.on("data", (d) => {
			err += String(d);
		});
		archive.stdout.pipe(extract.stdin);
		let archived: number | null = null;
		archive.on("error", reject);
		extract.on("error", reject);
		archive.on("close", (code) => {
			archived = code;
		});
		extract.on("close", (code) => {
			if (archived === 0 && code === 0) resolve();
			else reject(new Error(`Unpacking ${commitSha} failed: ${err.trim()}`));
		});
	});
}

/** The docker CLI on the host. The container sees only the --env values create passes. */
function docker(
	args: readonly string[],
	options: { timeoutMs?: number } = {},
): Promise<Exec> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { windowsHide: true });
		let output = "";
		child.stdout.on("data", (d) => {
			output += String(d);
		});
		child.stderr.on("data", (d) => {
			output += String(d);
		});
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ code, output });
		});
	});
}
