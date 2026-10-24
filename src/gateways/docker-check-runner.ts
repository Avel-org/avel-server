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

/** The only hosts the install may reach, on 443, through the proxy. */
export const REGISTRY_HOSTS: readonly string[] = ["registry.npmjs.org"];

const PROXY_PORT = 3128;

/**
 * The install's proxy, run by the image's own node: CONNECT to an
 * allowed host on 443 is tunnelled, and anything else is refused with
 * 403 and logged as `refused <target>`. It resolves and connects to the
 * name it was asked for, so an allowed name is the only way out.
 */
export const PROXY_SCRIPT = String.raw`
const http = require("http"), net = require("net");
const allow = new Set(JSON.parse(process.env.AVEL_ALLOW));
const refuse = (what) => console.log("refused " + String(what).slice(0, 200));
const server = http.createServer((req, res) => {
	refuse(req.method + " " + req.url);
	res.writeHead(403);
	res.end();
});
server.on("connect", (req, client, head) => {
	const m = /^([^:\s\/]+):(\d+)$/.exec(req.url || "");
	const host = m ? m[1].toLowerCase().replace(/\.$/, "") : "";
	if (!m || m[2] !== "443" || !allow.has(host)) {
		refuse(req.url);
		client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	const up = net.connect(443, host, () => {
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length) up.write(head);
		up.pipe(client);
		client.pipe(up);
	});
	up.on("error", () => client.destroy());
	client.on("error", () => up.destroy());
});
server.listen(${PROXY_PORT}, "0.0.0.0", () => console.log("listening"));
`;

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

export type Exec = { code: number | null; output: string };

/**
 * The gate's check runner on local Docker (decided 2026-10-22), under
 * SANDBOX.md's running-room rules. Each run gets a new container, removed
 * afterwards:
 *
 * 1. The commit's files, from `git archive`, never a working tree, are
 *    unpacked into /tmp/work. Nothing from the host is mounted.
 * 2. The install runs with `--ignore-scripts`, so the package manager is
 *    the only code that runs while the container has a network, and that
 *    network reaches the registry only. The container is on a network of
 *    its own, made `--internal`, so it has no route out and no outside
 *    DNS; the one way out is a proxy container (PROXY_SCRIPT) that
 *    tunnels to REGISTRY_HOSTS on 443 and refuses anything else. A
 *    commit's .npmrc, its lockfile's URLs and its git dependencies can
 *    name any host, and only the registry answers. A failed install shows
 *    what the proxy refused.
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
 * it. The proxy runs the same pinned image, as `node`, with no
 * capabilities, and is removed with the run's network once the install
 * is over.
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
			// Their networks, once no container holds them.
			const nets = await step([
				"network",
				"ls",
				"--quiet",
				"--filter",
				`name=^${PREFIX}`,
			]);
			const netIds = nets.output.split(/\s+/).filter(Boolean);
			if (netIds.length > 0) await step(["network", "rm", ...netIds]);
		},
		async run(request: CheckRunRequest): Promise<CheckRunResult[]> {
			if (request.checks.length === 0) return [];
			const stoppedAll = () => request.checks.map(() => errored(STOPPED));
			if (request.signal?.aborted) return stoppedAll();
			const name = `${PREFIX}${opts.ids.next()}`;
			const net = `${name}-net`;
			const proxy = `${name}-proxy`;
			// Removing the containers kills whatever runs in them now: the
			// docker exec waiting on it returns, and the run ends.
			const kill = () => {
				void step(["rm", "--force", name]);
				void step(["rm", "--force", proxy]);
			};
			request.signal?.addEventListener("abort", kill, { once: true });
			try {
				await must(
					step(["network", "create", "--internal", net]),
					"creating the install network",
				);
				try {
					const results = await runOn(net, proxy, name, request);
					return request.signal?.aborted
						? results.map((r) => (r.outcome === "error" ? errored(STOPPED) : r))
						: results;
				} catch (err) {
					if (request.signal?.aborted) return stoppedAll();
					throw err;
				} finally {
					await step(["rm", "--force", proxy]);
					await step(["network", "rm", net]);
				}
			} finally {
				request.signal?.removeEventListener("abort", kill);
			}
		},
	};

	/** The proxy on `bridge` and `net`, started and listening. */
	async function startProxy(net: string, proxy: string) {
		await must(
			step([
				"create",
				"--name",
				proxy,
				"--network",
				"bridge",
				"--user",
				"node",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--memory",
				"256m",
				"--pids-limit",
				"64",
				"--env",
				`AVEL_ALLOW=${JSON.stringify(REGISTRY_HOSTS)}`,
				opts.image,
				"node",
				"-e",
				PROXY_SCRIPT,
			]),
			"creating the install proxy",
		);
		await must(
			step(["network", "connect", net, proxy]),
			"connecting the install proxy",
		);
		await must(step(["start", proxy]), "starting the install proxy");
		for (let i = 0; i < 50; i++) {
			const logs = await step(["logs", proxy]);
			if (logs.output.includes("listening")) return;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error("The install proxy did not start listening");
	}

	/** What the proxy refused, for a failed install's error. */
	async function refusals(proxy: string): Promise<string> {
		const logs = await step(["logs", proxy]);
		const lines = logs.output
			.split("\n")
			.filter((l) => l.startsWith("refused "));
		return lines.length === 0
			? ""
			: `\nThe install may reach only ${REGISTRY_HOSTS.join(", ")}. Refused:\n${lines.join("\n")}`;
	}

	async function runOn(
		net: string,
		proxy: string,
		name: string,
		request: CheckRunRequest,
	): Promise<CheckRunResult[]> {
		const created = await step([
			"create",
			"--name",
			name,
			"--network",
			net,
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
			if (install.kind !== "none") {
				await startProxy(net, proxy);
				const via = `http://${proxy}:${PROXY_PORT}`;
				const proxied = [
					`HTTPS_PROXY=${via}`,
					`HTTP_PROXY=${via}`,
					`npm_config_https_proxy=${via}`,
					`npm_config_proxy=${via}`,
				];
				if (install.kind === "pnpm") {
					// From HOME, so the commit's .npmrc cannot pick the registry
					// this package manager comes from.
					const pm = await exec(
						name,
						`npm install --prefix ${PM} --no-save --no-audit --no-fund --ignore-scripts pnpm@${PINNED_PNPM}`,
						installTimeoutMs,
						HOME,
						["npm_config_registry=https://registry.npmjs.org/", ...proxied],
					);
					if (pm.code !== 0) {
						const refused = await refusals(proxy);
						return request.checks.map(() =>
							errored(
								`Installing pnpm ${PINNED_PNPM} failed:\n${pm.output}${refused}`,
							),
						);
					}
				}
				const done = await exec(name, install.command, installTimeoutMs, WORK, [
					...install.env,
					...proxied,
				]);
				if (done.code !== 0) {
					const refused = await refusals(proxy);
					return request.checks.map(() =>
						errored(`The install failed:\n${done.output}${refused}`),
					);
				}
				// The install is over: nothing needs the way out now.
				await step(["rm", "--force", proxy]);
			}

			await must(
				step(["network", "disconnect", "--force", net, name]),
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
				if (request.shouldStop?.() || request.signal?.aborted) {
					results.push(errored(STOPPED));
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
	}
}

/** A check the run was stopped before it could finish. */
const STOPPED = "Not run: the run was stopped before this check finished";

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
/**
 * One docker CLI call with a time limit, holding the end of its output.
 * env, when given, is the CLI's whole environment: a value named by
 * `--env NAME` alone is read from it, so it never appears in the arguments.
 */
export function docker(
	args: readonly string[],
	options: { timeoutMs: number; outputBytes: number; env?: NodeJS.ProcessEnv },
): Promise<Exec> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, {
			windowsHide: true,
			...(options.env ? { env: options.env } : {}),
		});
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
