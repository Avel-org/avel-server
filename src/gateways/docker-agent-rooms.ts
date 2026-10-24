import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
	SpawnedProcess,
	SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { docker, PINNED_IMAGE, tailOf } from "./docker-check-runner";

/**
 * Where an agent's Claude Code process runs (decided 2026-10-24, J: the
 * agent room). The SDK talks to that process over its stdin and stdout
 * only, and AVEL's tools run in the server, so the process can run in a
 * container while the room stays a worktree on the host.
 */
export type AgentRoom = {
	/** The SDK's spawnClaudeCodeProcess, for this one session. */
	spawn: (options: SpawnOptions) => SpawnedProcess;
	/** Removes the agent's container, its proxy and its network. Idempotent. */
	close: () => Promise<void>;
	/** The end of the docker CLI's stderr, for a session that failed. */
	stderr: () => string;
};

export type AgentRooms = {
	id: string;
	/** A room for one session. `apiKey` goes to the room's key proxy only. */
	open: (name: string, apiKey: string) => Promise<AgentRoom>;
	/** Removes every leftover room: a restart's first step. */
	sweep: () => Promise<void>;
};

/** Every agent room's containers and network start with this; sweep removes them by it. */
const PREFIX = "avel-agent-";

/** Where the Claude Code binary is mounted, read-only. */
const BINARY = "/opt/avel/claude";
const PROXY_PORT = 8080;

/** The only requests the key proxy forwards: the model API's messages. */
export const KEY_PROXY_PATHS: readonly string[] = [
	"/v1/messages",
	"/v1/messages/count_tokens",
];

/**
 * The room's one way out, run by the image's own node. It is a reverse
 * proxy, so the caller cannot name a host: a POST to one of
 * KEY_PROXY_PATHS goes to AVEL_UPSTREAM (api.anthropic.com over TLS) with
 * the real key put in, and anything else, CONNECT included, is refused
 * with 403 and logged as `refused <what>`. The key is read from the
 * proxy's environment; the agent's container only ever holds a placeholder.
 */
export const KEY_PROXY_SCRIPT = String.raw`
const http = require("http"), https = require("https");
const allow = new Set(JSON.parse(process.env.AVEL_PATHS));
const up = new URL(process.env.AVEL_UPSTREAM);
const client = up.protocol === "https:" ? https : http;
const key = process.env.ANTHROPIC_API_KEY;
const refuse = (what) => console.log("refused " + String(what).slice(0, 200));
const server = http.createServer((req, res) => {
	const p = new URL(req.url || "/", "http://x").pathname;
	if (req.method !== "POST" || !allow.has(p)) {
		refuse(req.method + " " + p);
		res.writeHead(403);
		res.end();
		return;
	}
	const headers = { ...req.headers, host: up.host, "x-api-key": key };
	delete headers.authorization;
	const out = client.request(
		{ protocol: up.protocol, hostname: up.hostname, port: up.port || (up.protocol === "https:" ? 443 : 80), method: "POST", path: req.url, headers },
		(r) => {
			res.writeHead(r.statusCode || 502, r.headers);
			r.pipe(res);
		},
	);
	out.on("error", (e) => {
		console.log("upstream error " + e.message);
		if (!res.headersSent) res.writeHead(502);
		res.end();
	});
	req.pipe(out);
});
server.on("connect", (req, sock) => {
	refuse("CONNECT " + req.url);
	sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
server.listen(${PROXY_PORT}, "0.0.0.0", () => console.log("listening"));
`;

/**
 * The Linux build of the Claude Code binary the SDK runs, at the SDK's
 * own version: pnpm installs it from the lockfile (package.json
 * supportedArchitectures), so its bytes are checked like any dependency.
 */
export function linuxClaudeBinary(): string {
	const req = createRequire(import.meta.url);
	const sdk = createRequire(req.resolve("@anthropic-ai/claude-agent-sdk"));
	let dir: string;
	try {
		dir = path.dirname(
			sdk.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json"),
		);
	} catch {
		throw new Error(
			"The Linux build of Claude Code is not installed: run pnpm install (package.json supportedArchitectures adds it)",
		);
	}
	const binary = path.join(dir, "claude");
	if (!existsSync(binary)) throw new Error(`${binary} is missing`);
	return binary;
}

export type DockerAgentRoomsOptions = {
	/** A glibc image with node, pinned by digest (AVEL_AGENT_IMAGE). */
	image: string;
	/** The host path of the Linux Claude Code binary. Default linuxClaudeBinary(). */
	binary?: string;
	/** Where the key proxy forwards. Default https://api.anthropic.com; tests point it elsewhere. */
	upstream?: string;
	/** For each docker step. Default 2 minutes. */
	stepTimeoutMs?: number;
	memory?: string;
	cpus?: string;
	pids?: number;
};

/** The SDK's variables the process reads at start; nothing else from the host goes in. */
const passes = (name: string) =>
	name.startsWith("CLAUDE_CODE_") || name.startsWith("CLAUDE_AGENT_SDK_");

/**
 * Agent rooms on local Docker. Each session gets:
 *
 * - its own `--internal` network: no route out and no outside DNS;
 * - a key proxy container (KEY_PROXY_SCRIPT) on that network and the
 *   bridge, the only way out, holding the API key;
 * - the agent's container, from `docker run -i`, running the mounted
 *   Claude Code binary as `node`, with no capabilities, no new privileges,
 *   a read-only root, tmpfs for /tmp, its home and its working directory,
 *   and caps on memory, CPU and processes. Nothing else from the host is
 *   mounted. Its environment is the SDK's own variables plus a placeholder
 *   key and the proxy as its API address.
 *
 * Closing removes all three. Containers and network are named
 * `avel-agent-<name>`, so sweep finds a crashed server's leftovers.
 */
export function dockerAgentRooms(opts: DockerAgentRoomsOptions): AgentRooms {
	if (!PINNED_IMAGE.test(opts.image)) {
		throw new Error(
			`The agent image ${opts.image} is not pinned by digest (name@sha256:<64 hex>)`,
		);
	}
	const binary = opts.binary ?? linuxClaudeBinary();
	const upstream = opts.upstream ?? "https://api.anthropic.com";
	const stepMs = opts.stepTimeoutMs ?? 2 * 60_000;
	const step = (args: readonly string[], env?: NodeJS.ProcessEnv) =>
		docker(args, { timeoutMs: stepMs, outputBytes: 64 * 1024, env });
	const must = async (
		args: readonly string[],
		what: string,
		env?: NodeJS.ProcessEnv,
	) => {
		const r = await step(args, env);
		if (r.code !== 0) throw new Error(`${what} failed: ${r.output.trim()}`);
		return r.output;
	};

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
		async open(name, apiKey) {
			const agent = `${PREFIX}${name}`;
			const net = `${agent}-net`;
			const proxy = `${agent}-proxy`;
			let closed: Promise<void> | undefined;
			const close = () => {
				closed ??= (async () => {
					await step(["rm", "--force", agent, proxy]);
					await step(["network", "rm", net]);
				})();
				return closed;
			};
			try {
				await must(
					["network", "create", "--internal", net],
					"creating the agent network",
				);
				// The key is named, not given: the docker CLI reads its value
				// from its own environment, so it is in no command line.
				await must(
					[
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
						"--read-only",
						"--memory",
						"256m",
						"--pids-limit",
						"64",
						"--env",
						"ANTHROPIC_API_KEY",
						"--env",
						`AVEL_UPSTREAM=${upstream}`,
						"--env",
						`AVEL_PATHS=${JSON.stringify(KEY_PROXY_PATHS)}`,
						opts.image,
						"node",
						"-e",
						KEY_PROXY_SCRIPT,
					],
					"creating the key proxy",
					{ ...process.env, ANTHROPIC_API_KEY: apiKey },
				);
				await must(
					["network", "connect", "--alias", "keyproxy", net, proxy],
					"connecting the key proxy",
				);
				await must(["start", proxy], "starting the key proxy");
				let listening = false;
				for (let i = 0; i < 50 && !listening; i++) {
					listening = (await step(["logs", proxy])).output.includes(
						"listening",
					);
					if (!listening) await new Promise((r) => setTimeout(r, 100));
				}
				if (!listening)
					throw new Error("The key proxy did not start listening");
			} catch (err) {
				await close();
				throw err;
			}
			const errors = tailOf(4096);
			return {
				close,
				stderr: errors.text,
				spawn(o) {
					const env = [
						...Object.entries(o.env)
							.filter(([k, v]) => v !== undefined && passes(k))
							.map(([k, v]) => `${k}=${v}`),
						"HOME=/home/node",
						"CLAUDE_CONFIG_DIR=/home/node/.claude-avel",
						`ANTHROPIC_BASE_URL=http://keyproxy:${PROXY_PORT}`,
						// The process wants a key to start; the proxy replaces it.
						"ANTHROPIC_API_KEY=avel-key-proxy",
						"DISABLE_TELEMETRY=1",
						"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
					];
					const child = spawn(
						"docker",
						[
							"run",
							"--interactive",
							"--rm",
							"--name",
							agent,
							"--network",
							net,
							"--user",
							"node",
							"--cap-drop",
							"ALL",
							"--security-opt",
							"no-new-privileges",
							"--read-only",
							"--tmpfs",
							"/tmp",
							"--tmpfs",
							"/home/node:uid=1000,gid=1000",
							"--tmpfs",
							"/work:uid=1000,gid=1000",
							"--memory",
							opts.memory ?? "2g",
							"--cpus",
							opts.cpus ?? "2",
							"--pids-limit",
							String(opts.pids ?? 256),
							"--volume",
							`${binary}:${BINARY}:ro`,
							"--workdir",
							"/work",
							"--entrypoint",
							BINARY,
							...env.flatMap((e) => ["--env", e]),
							opts.image,
							...o.args,
						],
						{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
					);
					child.stderr?.on("data", errors.push);
					// All three streams are pipes, so stdin and stdout are set.
					return child as ChildProcess & SpawnedProcess;
				},
			};
		},
	};
}
