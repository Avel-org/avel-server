import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	type AgentRoom,
	dockerAgentRooms,
	KEY_PROXY_PATHS,
	linuxClaudeBinary,
} from "../../src/gateways/docker-agent-rooms";
import { AGENT_SDK_VERSION } from "../../src/runner/agent-sdk-harness";

// Agent rooms on real Docker (decided 2026-10-24). They need a pinned
// image, as the check runner's tests do: AVEL_DOCKER_TEST_IMAGE, set in CI,
// where a missing one is an error.
const IMAGE = process.env.AVEL_DOCKER_TEST_IMAGE;
if (process.env.CI && !IMAGE) {
	throw new Error(
		"CI must run the agent room tests: set AVEL_DOCKER_TEST_IMAGE",
	);
}

vi.setConfig({ testTimeout: 120_000 });

const SECRET = `sk-ant-test-${randomUUID()}`;

const docker = (...args: string[]) =>
	execFileSync("docker", args, {
		windowsHide: true,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const tryDocker = (...args: string[]) => {
	try {
		return docker(...args);
	} catch (e) {
		return `error: ${(e as Error).message}`;
	}
};
const named = (prefix: string) =>
	docker("ps", "-a", "--filter", `name=^${prefix}`, "--format", "{{.Names}}");
const nets = (prefix: string) =>
	docker(
		"network",
		"ls",
		"--filter",
		`name=^${prefix}`,
		"--format",
		"{{.Name}}",
	);

/**
 * An upstream that echoes what the key proxy sent it, on the default
 * bridge, where the proxy can reach it and the agent's network cannot.
 */
let upstream: { name: string; url: string } | undefined;
async function echoUpstream() {
	if (upstream) return upstream;
	const name = `avel-test-upstream-${randomUUID().slice(0, 8)}`;
	docker(
		"run",
		"-d",
		"--name",
		name,
		IMAGE as string,
		"node",
		"-e",
		`require("http").createServer((q,s)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{s.setHeader("content-type","application/json");s.end(JSON.stringify({method:q.method,url:q.url,headers:q.headers,body:b}))})}).listen(9000,()=>console.log("listening"))`,
	);
	for (let i = 0; i < 50 && !docker("logs", name).includes("listening"); i++) {
		await new Promise((r) => setTimeout(r, 100));
	}
	const ip = docker(
		"inspect",
		"--format",
		"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
		name,
	);
	upstream = { name, url: `http://${ip}:9000` };
	return upstream;
}

afterAll(() => {
	if (upstream) tryDocker("rm", "--force", upstream.name);
});

/** A node script run on the room's network, as anything in the agent's container could. */
const onRoomNet = (net: string, script: string) =>
	tryDocker(
		"run",
		"--rm",
		"--network",
		net,
		IMAGE as string,
		"node",
		"-e",
		script,
	);

const fetchScript = (url: string, init: object = {}) =>
	`fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000),...${JSON.stringify(init)}}).then(async r=>console.log("status",r.status,await r.text())).catch(e=>console.log("failed",e.cause?.code??e.message))`;

/** A room, opened and closed around fn. */
async function withRoom(
	fn: (room: AgentRoom, name: string) => Promise<void>,
	over: { upstream?: string } = {},
) {
	const name = randomUUID();
	const room = await dockerAgentRooms({ image: IMAGE as string, ...over }).open(
		name,
		SECRET,
	);
	try {
		await fn(room, name);
	} finally {
		await room.close();
	}
}

/** Runs until its stdin closes: the SDK's stream-json mode waits on it. */
const WAITING_ARGS = [
	"--output-format",
	"stream-json",
	"--input-format",
	"stream-json",
	"--verbose",
];

describe("dockerAgentRooms", () => {
	it("refuses an image not pinned by digest", () => {
		expect(() => dockerAgentRooms({ image: "node:24", binary: "x" })).toThrow(
			/not pinned by digest/,
		);
	});

	it("finds the Linux Claude Code binary at the SDK's version", () => {
		const binary = linuxClaudeBinary();
		expect(binary).toMatch(/claude-agent-sdk-linux-x64/);
		expect(binary).toContain(AGENT_SDK_VERSION);
	});
});

describe.skipIf(!IMAGE)("dockerAgentRooms on Docker", () => {
	it("runs the SDK's Claude Code binary in the room", async () => {
		await withRoom(async (room) => {
			const child = room.spawn({
				signal: new AbortController().signal,
				command: "claude",
				args: ["--version"],
				env: {},
			});
			let out = "";
			child.stdout.on("data", (d: Buffer) => {
				out += d.toString();
			});
			const code = await new Promise((r) => child.on("exit", r));
			expect(code).toBe(0);
			expect(out).toMatch(/\(Claude Code\)/);
		});
	});

	it("keeps the key and the host out of the agent's container: its env, its arguments and its mounts", async () => {
		await withRoom(async (room, name) => {
			const child = room.spawn({
				signal: new AbortController().signal,
				command: "C:\\host\\claude.exe",
				args: WAITING_ARGS,
				cwd: "C:\\host\\room",
				env: {
					ANTHROPIC_API_KEY: SECRET,
					PATH: "C:\\host\\bin",
					HOME: "C:\\Users\\host",
					DATABASE_URL: "postgres://host-secret",
					CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
					CLAUDE_AGENT_SDK_CLIENT_APP: "avel-server",
				},
			});
			const agent = `avel-agent-${name}`;
			let inspect = "";
			for (let i = 0; i < 100 && !inspect.startsWith("["); i++) {
				inspect = tryDocker("inspect", agent);
				if (!inspect.startsWith("["))
					await new Promise((r) => setTimeout(r, 100));
			}
			const [c] = JSON.parse(inspect) as Array<{
				Config: { Env: string[]; Cmd: string[] };
				Mounts: Array<{ Destination: string; RW: boolean }>;
				HostConfig: { CapDrop: string[]; ReadonlyRootfs: boolean };
			}>;
			child.stdin.end();
			await new Promise((r) => child.on("exit", r));
			if (!c) throw new Error("no container");
			expect(inspect).not.toContain(SECRET);
			expect(inspect).not.toContain("host-secret");
			expect(inspect).not.toContain("C:\\\\host");
			expect(c.Config.Env).toContain("ANTHROPIC_API_KEY=avel-key-proxy");
			expect(c.Config.Env).toContain("ANTHROPIC_BASE_URL=http://keyproxy:8080");
			expect(c.Config.Env).toContain("CLAUDE_CODE_DISABLE_CLAUDE_MDS=1");
			expect(c.Config.Env).toContain("CLAUDE_AGENT_SDK_CLIENT_APP=avel-server");
			expect(c.Config.Env.some((e) => e.startsWith("DATABASE_URL="))).toBe(
				false,
			);
			expect(c.Config.Cmd).toEqual(WAITING_ARGS);
			expect(c.Mounts.map((m) => [m.Destination, m.RW])).toEqual([
				["/opt/avel/claude", false],
			]);
			expect(c.HostConfig.CapDrop).toEqual(["ALL"]);
			expect(c.HostConfig.ReadonlyRootfs).toBe(true);
		});
	});

	it("forwards the messages API through the key proxy with the real key, and refuses every other request", async () => {
		const up = await echoUpstream();
		await withRoom(
			async (_room, name) => {
				const net = `avel-agent-${name}-net`;
				const sent = onRoomNet(
					net,
					fetchScript("http://keyproxy:8080/v1/messages?beta=true", {
						method: "POST",
						headers: {
							"x-api-key": "avel-key-proxy",
							authorization: "Bearer agent",
						},
						body: "{}",
					}),
				);
				const echoed = JSON.parse(sent.replace(/^status 200 /, "")) as {
					method: string;
					url: string;
					headers: Record<string, string>;
				};
				expect(echoed.method).toBe("POST");
				expect(echoed.url).toBe("/v1/messages?beta=true");
				expect(echoed.headers["x-api-key"]).toBe(SECRET);
				expect(echoed.headers.authorization).toBeUndefined();
				for (const [path, method] of [
					["/v1/models", "GET"],
					["/v1/files", "POST"],
					["/v1/messages", "GET"],
					["/v1/messages/batches", "POST"],
				] as const) {
					expect(
						onRoomNet(
							net,
							fetchScript(`http://keyproxy:8080${path}`, { method }),
						),
						`${method} ${path}`,
					).toMatch(/^status 403/);
				}
				const tunnel = onRoomNet(
					net,
					`require("http").request({host:"keyproxy",port:8080,method:"CONNECT",path:"example.com:443"}).on("connect",(r)=>{console.log("status",r.statusCode);process.exit(0)}).on("error",e=>console.log("failed",e.code)).end()`,
				);
				expect(tunnel).toMatch(/^status 403/);
				const logs = docker("logs", `avel-agent-${name}-proxy`);
				expect(logs).toContain("refused GET /v1/models");
				expect(logs).toContain("refused CONNECT example.com:443");
			},
			{ upstream: up.url },
		);
		expect(KEY_PROXY_PATHS).toEqual([
			"/v1/messages",
			"/v1/messages/count_tokens",
		]);
	});

	it("gives the agent's network no way out but the proxy: no outside name, no direct address", async () => {
		const up = await echoUpstream();
		await withRoom(async (_room, name) => {
			const net = `avel-agent-${name}-net`;
			expect(
				onRoomNet(net, fetchScript("https://api.anthropic.com/v1/messages")),
			).toMatch(/^failed (EAI_AGAIN|ENOTFOUND)/);
			expect(onRoomNet(net, fetchScript(`${up.url}/v1/messages`))).toMatch(
				/^failed (ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|The operation was aborted)/,
			);
		});
	});

	it("closes to nothing, twice, and removes a running agent at once", async () => {
		const name = randomUUID();
		const prefix = `avel-agent-${name}`;
		const room = await dockerAgentRooms({ image: IMAGE as string }).open(
			name,
			SECRET,
		);
		const child = room.spawn({
			signal: new AbortController().signal,
			command: "claude",
			args: WAITING_ARGS,
			env: {},
		});
		for (
			let i = 0;
			i < 100 &&
			!named(prefix).includes(`${prefix}\n`) &&
			named(prefix).split("\n").length < 2;
			i++
		) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(named(prefix).split("\n").sort()).toEqual([
			prefix,
			`${prefix}-proxy`,
		]);
		const exited = new Promise((r) => child.on("exit", r));
		await room.close();
		await room.close();
		await exited;
		expect(named(prefix)).toBe("");
		expect(nets(prefix)).toBe("");
	});

	it("leaves nothing when the room cannot open, and sweep removes a crashed server's rooms", async () => {
		const name = randomUUID();
		const prefix = `avel-agent-${name}`;
		await expect(
			dockerAgentRooms({ image: `node@sha256:${"0".repeat(64)}` }).open(
				name,
				SECRET,
			),
		).rejects.toThrow(/creating the key proxy failed/);
		expect(named(prefix)).toBe("");
		expect(nets(prefix)).toBe("");

		const left = randomUUID();
		await dockerAgentRooms({ image: IMAGE as string }).open(left, SECRET);
		expect(named(`avel-agent-${left}`)).not.toBe("");
		// Sweep is server-wide by design: it also removes any other room on
		// this Docker, such as a dev server's.
		await dockerAgentRooms({ image: IMAGE as string }).sweep();
		expect(named("avel-agent-")).toBe("");
		expect(nets("avel-agent-")).toBe("");
	});
});
