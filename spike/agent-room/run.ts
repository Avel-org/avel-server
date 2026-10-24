// Spike (2026-10-24, sandbox proposal, questions 1, 2 and 4): one live SDK
// session whose Claude Code process runs in a container with nothing
// mounted, on an --internal network whose only way out is a key proxy to
// api.anthropic.com. The agent calls one in-process AVEL tool. Throwaway
// code: run with `pnpm exec tsx --env-file=../avel-server/.env spike/agent-room/run.ts`.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	createSdkMcpServer,
	query,
	type SpawnOptions,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const IMAGE = "avel-agent-spike:0.3.296";
const PROXY_IMAGE =
	"node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

const id = randomBytes(4).toString("hex");
const net = `avel-agent-spike-${id}-net`;
const proxy = `avel-agent-spike-${id}-proxy`;
const agent = `avel-agent-spike-${id}-agent`;
const docker = (...a: string[]) =>
	execFileSync("docker", a, { encoding: "utf-8" }).trim();

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

function cleanup() {
	for (const c of [agent, proxy]) {
		try {
			docker("rm", "--force", c);
		} catch {}
	}
	try {
		docker("network", "rm", net);
	} catch {}
}

/** The SDK's launch, in a container: host paths become container paths, and the key stays out. */
function inContainer(o: SpawnOptions) {
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
		// A placeholder: the process wants a key; the proxy replaces it.
		"ANTHROPIC_API_KEY=avel-proxy-placeholder",
		"DISABLE_TELEMETRY=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
	];
	const args = [
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
		IMAGE,
		"claude",
		...o.args,
	];
	console.log("[spawn] host command was", o.command);
	return spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
}

async function main() {
	cleanup();
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

	const nonce = randomBytes(6).toString("hex");
	let toolCalls = 0;
	const avel = createSdkMcpServer({
		name: "avel",
		version: "1",
		tools: [
			tool("secret_note", "Returns today's note.", {}, async () => {
				toolCalls += 1;
				return { content: [{ type: "text", text: `note: ${nonce}` }] };
			}),
		],
	});

	let firstByte: number | undefined;
	let spawnedAt = 0;
	const t0 = performance.now();
	let reply = "";
	let envSeen = "";
	const q = query({
		prompt:
			"Call the secret_note tool once, then reply with only the text it returned.",
		options: {
			model: "claude-sonnet-5-5",
			cwd: "/work",
			settingSources: [],
			strictMcpConfig: true,
			tools: [],
			mcpServers: { avel },
			allowedTools: ["mcp__avel__secret_note"],
			permissionMode: "dontAsk",
			persistSession: false,
			maxTurns: 4,
			env: {
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
				CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
				CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
				CLAUDE_AGENT_SDK_CLIENT_APP: "avel-server",
			},
			spawnClaudeCodeProcess: (o) => {
				spawnedAt = performance.now();
				const child = inContainer(o);
				child.stdout?.once("data", () => {
					firstByte = performance.now();
				});
				// While it runs, read the container's environment from Docker.
				setTimeout(() => {
					try {
						envSeen = docker(
							"inspect",
							"--format",
							"{{range .Config.Env}}{{println .}}{{end}}",
							agent,
						);
					} catch (e) {
						envSeen = `inspect failed: ${(e as Error).message}`;
					}
				}, 1500);
				return child as never;
			},
		},
	});
	for await (const m of q) {
		if (m.type === "result") {
			reply = "result" in m ? String(m.result) : JSON.stringify(m);
			console.log("[result]", m.subtype, "cost", m.total_cost_usd);
		}
	}
	const t1 = performance.now();

	// Egress from the agent's network, as the agent would try it.
	const probe = (url: string) => {
		try {
			return docker(
				"run",
				"--rm",
				"--network",
				net,
				IMAGE,
				"node",
				"-e",
				`fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(r=>console.log("reached",r.status)).catch(e=>console.log("failed",e.cause?.code??e.message))`,
			);
		} catch (e) {
			return `error ${(e as Error).message}`;
		}
	};

	console.log(
		JSON.stringify(
			{
				q1_toolCalls: toolCalls,
				q1_replyHasNonce: reply.includes(nonce),
				q2_reply: reply.slice(0, 200),
				q4_spawnToFirstByteMs: firstByte && Math.round(firstByte - spawnedAt),
				q4_sessionMs: Math.round(t1 - t0),
				keyInAgentEnv: envSeen.includes(key),
				agentEnvKeys: envSeen
					.split("\n")
					.filter(Boolean)
					.map((l) => l.split("=")[0]),
				egress_direct_https: probe("https://api.anthropic.com/v1/models"),
				egress_other_host: probe("https://example.com"),
				egress_via_proxy: probe("http://keyproxy:8080/v1/models"),
				proxyLog: docker("logs", proxy).split("\n").slice(-8),
			},
			null,
			1,
		),
	);
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(cleanup);
