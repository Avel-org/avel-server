// Spike (2026-10-24, sandbox proposal, question 3): what the SDK hands
// spawnClaudeCodeProcess for a real dispatch's options. No model call: the
// hook records the launch and returns a process that exits at once.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { AgentSdkHarness } from "../../src/runner/agent-sdk-harness";

let seen: SpawnOptions | undefined;
const harness = new AgentSdkHarness({
	model: "claude-sonnet-5-5",
	apiKey: "sk-probe-not-a-key",
	configDir: "C:/probe/config",
});
const tools = {} as never;
const options = harness.sessionOptions(
	{
		dispatchId: "d",
		token: "t",
		model: "claude-sonnet-5-5",
		roomRoot: "C:/probe/room",
		writableGlobs: [],
		roomRepoPath: "C:/probe/repo",
		roomCommit: "a".repeat(40),
		checks: [],
		identityMd: "# probe",
		briefMd: "brief",
		skills: [],
	} as never,
	tools,
	new AbortController(),
);
const q = query({
	prompt: "probe",
	options: {
		...options,
		spawnClaudeCodeProcess: (o) => {
			seen = o;
			const p = new EventEmitter() as EventEmitter & Record<string, unknown>;
			Object.assign(p, {
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				killed: false,
				exitCode: 1,
				kill: () => true,
			});
			setTimeout(() => {
				(p.stdout as PassThrough).end();
				p.emit("exit", 1, null);
			}, 50);
			return p as never;
		},
	},
});
try {
	for await (const _ of q) {
	}
} catch {}
const redact = (k: string, v: string | undefined) =>
	/KEY|TOKEN|SECRET/.test(k) ? `<${(v ?? "").length} chars>` : v;
console.log(
	JSON.stringify(
		{
			command: seen?.command,
			args: seen?.args,
			cwd: seen?.cwd,
			env: Object.fromEntries(
				Object.entries(seen?.env ?? {}).map(([k, v]) => [k, redact(k, v)]),
			),
		},
		null,
		1,
	),
);
