// Spike (2026-10-24): the agent's Claude Code process in a container, as a
// spawnClaudeCodeProcess hook. Throwaway: the build replaces it.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const PROXY_IMAGE =
	"node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";

// A reverse proxy: every request goes to api.anthropic.com over TLS with the
// real key put in; there is no way to name another host. CONNECT is refused.
const PROXY = String.raw`
const http = require("node:http"), https = require("node:https");
const key = process.env.ANTHROPIC_API_KEY;
const s = http.createServer((req, res) => {
  const headers = { ...req.headers, host: "api.anthropic.com", "x-api-key": key };
  delete headers.authorization;
  const up = https.request({ host: "api.anthropic.com", port: 443, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on("error", (e) => { console.log("upstream error", e.message); res.writeHead(502); res.end(); });
  console.log("forward", req.method, req.url);
  req.pipe(up);
});
s.on("connect", (req, sock) => { console.log("refused CONNECT", req.url); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
s.listen(8080, () => console.log("listening"));
`;

const docker = (...a: string[]) =>
	execFileSync("docker", a, { encoding: "utf-8" }).trim();

export type AgentRoom = {
	net: string;
	proxy: string;
	agent: string;
	spawn: (o: SpawnOptions) => ReturnType<typeof spawn>;
	proxyLog: () => string[];
	agentEnv: () => string;
	close: () => void;
};

/** One session's network, key proxy and spawn hook. */
export async function openAgentRoom(
	image: string,
	key: string,
): Promise<AgentRoom> {
	const id = randomBytes(4).toString("hex");
	const net = `avel-agent-spike-${id}-net`;
	const proxy = `avel-agent-spike-${id}-proxy`;
	const agent = `avel-agent-spike-${id}-agent`;
	docker("network", "create", "--internal", net);
	docker(
		"run",
		"-d",
		"--name",
		proxy,
		"--network",
		"bridge",
		"-e",
		`ANTHROPIC_API_KEY=${key}`,
		PROXY_IMAGE,
		"node",
		"-e",
		PROXY,
	);
	docker("network", "connect", "--alias", "keyproxy", net, proxy);
	for (let i = 0; i < 50 && !docker("logs", proxy).includes("listening"); i++) {
		await new Promise((r) => setTimeout(r, 100));
	}
	let envSeen = "";
	return {
		net,
		proxy,
		agent,
		spawn: (o) => {
			const keep = Object.entries(o.env).filter(
				([k, v]) =>
					v !== undefined &&
					(k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK_")),
			);
			const env = [
				...keep.map(([k, v]) => `${k}=${v}`),
				"HOME=/home/node",
				"CLAUDE_CONFIG_DIR=/home/node/.claude-avel",
				"ANTHROPIC_BASE_URL=http://keyproxy:8080",
				"ANTHROPIC_API_KEY=avel-proxy-placeholder",
				"DISABLE_TELEMETRY=1",
				"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			];
			const child = spawn(
				"docker",
				[
					"run",
					"-i",
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
					"2g",
					"--pids-limit",
					"256",
					"-w",
					"/work",
					...env.flatMap((e) => ["-e", e]),
					image,
					"claude",
					...o.args,
				],
				{ stdio: ["pipe", "pipe", "inherit"] },
			);
			setTimeout(() => {
				try {
					envSeen = docker(
						"inspect",
						"--format",
						"{{range .Config.Env}}{{println .}}{{end}}",
						agent,
					);
				} catch {}
			}, 1500);
			return child;
		},
		proxyLog: () => docker("logs", proxy).split("\n"),
		agentEnv: () => envSeen,
		close: () => {
			for (const c of [agent, proxy]) {
				try {
					docker("rm", "--force", c);
				} catch {}
			}
			try {
				docker("network", "rm", net);
			} catch {}
		},
	};
}
