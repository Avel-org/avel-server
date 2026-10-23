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
const HOME = "/tmp/home";
/** Where the pinned pnpm is installed, apart from the commit's files. */
const PM = `${HOME}/.avel-pm`;

/** Every check container's name starts with this; sweep removes leftovers by it. */
const PREFIX = "avel-check-";

/** The pnpm a pnpm-lock.yaml installs with: pinned here, never read from the commit. */
export const PINNED_PNPM = "10.34.6";

export type DockerCheckRunnerOptions = {
	/** The image the checks run in, pinned by digest (AVEL_CHECK_IMAGE). */
	image: string;
	/** Names each run's container. */
	ids: IdGenerator;
	/** Per check. Default 10 minutes. */
	checkTimeoutMs?: number;
	/** For the install. Default 10 minutes. */
	installTimeoutMs?: number;
	/** For each docker step that is not a check or the install. Default 2 minutes. */
	stepTimeoutMs?: number;
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
 *    That package manager is never one the commit names: npm comes with the
 *    image, and pnpm is installed at PINNED_PNPM from the public registry,
 *    outside the commit's directory, with `packageManager` switching off.
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
 * Every docker step has a time limit, and only the end of each command's
 * output is held, so neither a hung daemon nor a noisy check can hold the
 * server. The container gets no host environment, so no credential reaches
 * it. Registry-only egress during the install is not built: the install's
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
	const stepMs = opts.stepTimeoutMs ?? 2 * 60_000;
	const outputBytes = opts.outputBytes ?? 64 * 1024;
	const step = (args: readonly string[]) =>
		docker(args, { timeoutMs: stepMs, outputBytes });
	const exec = (
		name: string,
		command: string,
		ms: number,
		workdir = WORK,
		env: readonly string[] = [],
	) => inContainer(name, command, { ms, workdir, env, outputBytes });

	return {
		id: `docker:${opts.image}`,
		async sweep() {
			const listed = await step([
				"ps",
				"--all",
				"--quiet",
				"--filter",
				`name=^${PREFIX}`,
			]);
			const ids = listed.output.split(/\s+/).filter(Boolean);
			if (ids.length > 0) await step(["rm", "--force", ...ids]);
		},
		async run(request: CheckRunRequest): Promise<CheckRunResult[]> {
			if (request.checks.length === 0) return [];
			const name = `${PREFIX}${opts.ids.next()}`;
			const created = await step([
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
				`HOME=${HOME}`,
				opts.image,
				"sleep",
				"infinity",
			]);
			if (created.code !== 0) {
				throw new Error(`docker create failed: ${created.output.trim()}`);
			}
			try {
				await must(step(["start", name]), "docker start");
				await must(
					step(["exec", name, "mkdir", "-p", WORK, HOME]),
					"preparing the work directory",
				);
				await unpack(request.source, request.commitSha, name, stepMs);

				const install = await installCommand(request.source, request.commitSha);
				if (install.kind === "refused") {
					return request.checks.map(() => errored(install.why));
				}
				if (install.kind === "pnpm") {
					// From HOME, so the commit's .npmrc cannot pick the registry
					// this package manager comes from.
					const pm = await exec(
						name,
						`npm install --prefix ${PM} --no-save --no-audit --no-fund --ignore-scripts pnpm@${PINNED_PNPM}`,
						installTimeoutMs,
						HOME,
						["npm_config_registry=https://registry.npmjs.org/"],
					);
					if (pm.code !== 0) {
						return request.checks.map(() =>
							errored(`Installing pnpm ${PINNED_PNPM} failed:\n${pm.output}`),
						);
					}
				}
				if (install.kind !== "none") {
					const done = await exec(
						name,
						install.command,
						installTimeoutMs,
						WORK,
						install.env,
					);
					if (done.code !== 0) {
						return request.checks.map(() =>
							errored(`The install failed:\n${done.output}`),
						);
					}
				}

				await must(
					step(["network", "disconnect", "--force", "bridge", name]),
					"leaving the network",
				);
				const networks = await must(
					step([
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
					if (request.shouldStop?.()) {
						results.push(
							errored("Not run: the gate job reached its time limit"),
						);
						continue;
					}
					await request.onProgress?.(i, i);
					const r = await exec(name, check.command, checkTimeoutMs);
					// 124 is timeout's own exit, 137 a kill: either way it did not finish.
					results.push(
						r.code === null || r.code === 124 || r.code === 137
							? errored(r.output)
							: {
									outcome: r.code === 0 ? "pass" : "fail",
									exitCode: r.code,
									output: r.output,
								},
					);
				}
				await request.onProgress?.(results.length, null);
				return results;
			} finally {
				await step(["rm", "--force", name]);
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

/** A command as `node`, in `workdir`, killed at `ms`. */
function inContainer(
	name: string,
	command: string,
	o: {
		ms: number;
		workdir: string;
		env: readonly string[];
		outputBytes: number;
	},
) {
	const secs = Math.max(1, Math.ceil(o.ms / 1000));
	return docker(
		[
			"exec",
			"--workdir",
			o.workdir,
			...o.env.flatMap((e) => ["--env", e]),
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
		{ timeoutMs: o.ms + 30_000, outputBytes: o.outputBytes },
	);
}

/** What the install is, read from the commit's root, never from the container. */
async function installCommand(
	source: string,
	commitSha: string,
): Promise<
	| { kind: "none" }
	| { kind: "pnpm" | "npm"; command: string; env: string[] }
	| { kind: "refused"; why: string }
> {
	const root = new Set(
		(await git(["ls-tree", "--name-only", commitSha], { cwd: source }))
			.split("\n")
			.filter(Boolean),
	);
	if (root.has("pnpm-lock.yaml")) {
		return {
			kind: "pnpm",
			command: `${PM}/node_modules/.bin/pnpm install --frozen-lockfile --ignore-scripts`,
			// The commit's packageManager field never picks the pnpm that runs.
			env: [
				"npm_config_manage_package_manager_versions=false",
				"npm_config_package_manager_strict=false",
			],
		};
	}
	if (root.has("package-lock.json")) {
		return { kind: "npm", command: "npm ci --ignore-scripts", env: [] };
	}
	if (root.has("package.json")) {
		return {
			kind: "refused",
			why: "The commit has a package.json and no lockfile (pnpm-lock.yaml or package-lock.json), so nothing can be installed reproducibly",
		};
	}
	return { kind: "none" };
}

/**
 * `git archive` of the commit, unpacked into the work directory inside the
 * container. Resolves when both processes have exited cleanly, in either
 * order. A broken pipe, from tar exiting early, rejects instead of escaping
 * as an unhandled stream error.
 */
export function unpack(
	source: string,
	commitSha: string,
	name: string,
	ms: number,
) {
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
		const err = tailOf(16 * 1024);
		archive.stderr.on("data", err.push);
		extract.stderr.on("data", err.push);
		let failure: Error | null = null;
		const failed = (e: Error) => {
			failure ??= e;
		};
		archive.on("error", failed);
		extract.on("error", failed);
		archive.stdout.on("error", failed);
		extract.stdin.on("error", failed);
		archive.stdout.pipe(extract.stdin);
		const timer = setTimeout(() => {
			failed(new Error(`Unpacking ${commitSha} took longer than ${ms} ms`));
			archive.kill("SIGKILL");
			extract.kill("SIGKILL");
		}, ms);
		const codes: (number | null)[] = [];
		const closed = (code: number | null) => {
			codes.push(code);
			if (codes.length < 2) return;
			clearTimeout(timer);
			if (failure === null && codes.every((c) => c === 0)) resolve();
			else
				reject(
					new Error(
						`Unpacking ${commitSha} failed: ${failure?.message ?? ""} ${err.text().trim()}`,
					),
				);
		};
		archive.on("close", closed);
		extract.on("close", closed);
	});
}

/**
 * Keeps the last `max` bytes pushed to it, decoded once at the end, so a
 * multi-byte character is never split between chunks. It never holds more
 * than twice `max` (`held`).
 */
export function tailOf(max: number) {
	let chunks: Buffer[] = [];
	let size = 0;
	return {
		push: (d: Buffer | string) => {
			const b = typeof d === "string" ? Buffer.from(d, "utf8") : d;
			chunks.push(b);
			size += b.byteLength;
			// Trimmed past twice the cap, so a stream of small chunks is not re-sliced on each one.
			if (size > max * 2) {
				const joined = Buffer.concat(chunks).subarray(size - max);
				chunks = [joined];
				size = joined.byteLength;
			}
		},
		held: () => size,
		text: () => {
			const all = Buffer.concat(chunks);
			let start = Math.max(0, all.byteLength - max);
			// Start on a character: skip UTF-8 continuation bytes (10xxxxxx).
			while (start < all.byteLength && ((all[start] ?? 0) & 0xc0) === 0x80) {
				start++;
			}
			return all.subarray(start).toString("utf8");
		},
	};
}

/** The docker CLI on the host. The container sees only the --env values create and exec pass. */
function docker(
	args: readonly string[],
	options: { timeoutMs: number; outputBytes: number },
): Promise<Exec> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { windowsHide: true });
		const output = tailOf(options.outputBytes);
		child.stdout.on("data", output.push);
		child.stderr.on("data", output.push);
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output: output.text() });
		});
	});
}
