import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
	CheckRunner,
	CheckRunRequest,
	CheckRunResult,
	RunnableCheck,
} from "../../src/gateways/check-runner";
import { fixedClock } from "../../src/lib/clock";
import { sequentialIds } from "../../src/lib/ids";
import { worktreeRooms } from "../../src/rooms/provider";
import { AgentSdkHarness } from "../../src/runner/agent-sdk-harness";
import {
	type AgentCheckContext,
	agentTools,
	CHECK_OUTPUT_CHARS,
} from "../../src/runner/agent-tools";
import type { HarnessSession } from "../../src/runner/harness";
import { gitIn, makeRepo, removeDir, tempDir } from "./git-fixtures";
import { captureLogger } from "./support";

// run_checks (decided 2026-10-22): the agent runs its brief's checks on its
// room's files, as advice. A recording runner stands in for Docker; the
// room is a real worktree, so the commit the runner is handed is real.

vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("run-checks");
afterAll(() => removeDir(base));

const AT = "2026-10-23T09:00:00.000Z";

const CHECKS: RunnableCheck[] = [
	{ id: "c1", requirementId: "r1", kind: "test", command: "pnpm test" },
	{ id: "c2", requirementId: "r1", kind: "typecheck", command: "pnpm tsc" },
	{ id: "c3", requirementId: "r1", kind: "command", command: "pnpm lint" },
];

let n = 0;
const dispatchId = () =>
	`00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** A clone with one commit and a worktree room on it, writable under src/**. */
async function room() {
	const dir = path.join(base, `repo-${++n}`);
	const [pinned] = makeRepo(dir, {
		"package.json": '{ "name": "salon" }\n',
		"src/a.ts": "export const a = 1;\n",
	});
	const id = dispatchId();
	const r = await worktreeRooms(path.join(base, `rooms-${n}`)).open({
		dispatchId: id,
		repoPath: dir,
		commit: pinned as string,
		writableGlobs: ["src/**"],
	});
	return { id, dir, pinned: pinned as string, root: r.root };
}

type Recorded = CheckRunRequest & {
	/** The commit's files and parent, read from the clone while the run is going. */
	files: Record<string, string>;
	parent: string;
};

/** A runner that records each request and answers from `answer`. */
function recordingRunner(
	answer: (r: CheckRunRequest) => CheckRunResult[] | Promise<CheckRunResult[]>,
) {
	const runs: Recorded[] = [];
	const runner: CheckRunner = {
		id: "recording",
		async run(request) {
			const ls = gitIn(
				request.source,
				"ls-tree",
				"-r",
				"--name-only",
				request.commitSha,
			);
			const files: Record<string, string> = {};
			for (const f of ls.split("\n").filter(Boolean)) {
				files[f] = gitIn(request.source, "show", `${request.commitSha}:${f}`);
			}
			runs.push({
				...request,
				files,
				parent: gitIn(request.source, "rev-parse", `${request.commitSha}^`),
			});
			return answer(request);
		},
	};
	return { runner, runs };
}

const pass = (output = "ok"): CheckRunResult => ({
	outcome: "pass",
	exitCode: 0,
	output,
});

async function tools(over: Partial<AgentCheckContext> = {}) {
	const r = await room();
	const { runner, runs } = recordingRunner((req) =>
		req.checks.map(() => pass()),
	);
	let places = 1;
	let reports = 0;
	const run: AgentCheckContext = {
		runner,
		source: r.dir,
		commit: r.pinned,
		checks: CHECKS,
		clock: fixedClock(AT),
		acquire: () => {
			if (places === 0) return null;
			places -= 1;
			return () => {
				places += 1;
			};
		},
		stopped: () => false,
		...over,
	};
	const t = agentTools({
		dispatchId: r.id,
		token: "avl_dsp_secret",
		room: { root: r.root, writableGlobs: ["src/**"] },
		skills: [],
		api: async () => {
			reports += 1;
			return new Response(JSON.stringify({ success: true }), { status: 201 });
		},
		ids: sequentialIds(),
		beforeReport: async () => {},
		onReported: () => {},
		run,
	});
	return { t, r, runs, places: () => places, reports: () => reports };
}

describe("run_checks", () => {
	it("runs every check on a commit of the room as it is now, on the pinned commit, and leaves the room's index and HEAD alone", async () => {
		const { t, r, runs } = await tools();
		await t.roomWrite({ path: "src/b.ts", content: "export const b = 2;\n" });
		await t.roomEdit({ path: "src/a.ts", oldText: "1", newText: "3" });
		const status = gitIn(r.root, "status", "--porcelain");
		const head = gitIn(r.root, "rev-parse", "HEAD");

		const out = await t.runChecks({});
		expect(out.isError).toBeUndefined();
		expect(runs).toHaveLength(1);
		const [run] = runs;
		expect(run?.source).toBe(r.dir);
		expect(run?.checks).toEqual(CHECKS);
		expect(run?.parent).toBe(r.pinned);
		expect(run?.files).toEqual({
			"package.json": '{ "name": "salon" }',
			"src/a.ts": "export const a = 3;",
			"src/b.ts": "export const b = 2;",
		});
		expect(gitIn(r.root, "status", "--porcelain")).toBe(status);
		expect(gitIn(r.root, "rev-parse", "HEAD")).toBe(head);

		expect(out.text).toMatch(/^Advice only\./);
		expect(out.text).toContain(`3 of 3 passed`);
		expect(out.text).toContain(run?.commitSha);
		expect(out.text).toContain(
			"## c2 (typecheck): pass, exit code 0\npnpm tsc",
		);
	});

	it("makes the same commit for the same files at the same time", async () => {
		const { t, runs } = await tools();
		await t.runChecks({});
		await t.runChecks({});
		expect(runs[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(runs[1]?.commitSha).toBe(runs[0]?.commitSha);
	});

	it("runs only the checks named, in the brief's order", async () => {
		const { t, runs } = await tools();
		await t.runChecks({ checkIds: ["c3", "c1"] });
		expect(runs[0]?.checks.map((c) => c.id)).toEqual(["c1", "c3"]);
	});

	it("refuses an unknown check id, and runs nothing", async () => {
		const { t, runs } = await tools();
		const out = await t.runChecks({ checkIds: ["c1", "f1"] });
		expect(out.isError).toBe(true);
		expect(out.text).toBe(
			"unknown_check: f1 is not a check run_checks can run. Yours: c1, c2, c3",
		);
		expect(runs).toEqual([]);
	});

	it("refuses with no runner, and with no runnable checks", async () => {
		const none = await tools({ runner: null });
		const a = await none.t.runChecks({});
		expect(a.isError).toBe(true);
		expect(a.text).toMatch(/^no_runner:/);

		const empty = await tools({ checks: [] });
		const b = await empty.t.runChecks({});
		expect(b.isError).toBe(true);
		expect(b.text).toMatch(/^no_checks:/);
		expect(empty.runs).toEqual([]);
	});

	it("shows each outcome and exit code, and only the end of a long output", async () => {
		const long = `${"CUT".repeat(4)}${"y".repeat(CHECK_OUTPUT_CHARS)}`;
		const { runner } = recordingRunner(() => [
			{ outcome: "fail", exitCode: 1, output: long },
			{ outcome: "error", exitCode: null, output: "" },
		]);
		const { t } = await tools({ runner });
		const out = await t.runChecks({});
		expect(out.isError).toBeUndefined();
		expect(out.text).toContain("0 of 3 passed");
		expect(out.text).toContain("## c1 (test): fail, exit code 1\npnpm test\n");
		expect(out.text).toContain(
			`(last ${CHECK_OUTPUT_CHARS} characters)\n${"y".repeat(CHECK_OUTPUT_CHARS)}\n`,
		);
		expect(out.text).not.toContain("CUT");
		expect(out.text).toContain(
			"## c2 (typecheck): error, no exit code\npnpm tsc\n\n(no output)",
		);
		// A runner that answered short leaves the missing check an error.
		expect(out.text).toContain("## c3 (command): error, no result");
	});

	it("refuses a second run while one is going, and a run when every place is taken", async () => {
		let finish: (r: CheckRunResult[]) => void = () => {};
		// Only the first run waits to be finished.
		const { runner, runs } = recordingRunner((req) =>
			runs.length > 1
				? req.checks.map(() => pass())
				: new Promise<CheckRunResult[]>((resolve) => {
						finish = resolve;
					}),
		);
		const { t, places } = await tools({ runner });
		const first = t.runChecks({});
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		expect(places()).toBe(0);
		const again = await t.runChecks({});
		expect(again.isError).toBe(true);
		expect(again.text).toMatch(/^already_running:/);

		const other = await tools({ acquire: () => null });
		const busy = await other.t.runChecks({});
		expect(busy.isError).toBe(true);
		expect(busy.text).toMatch(/^runner_busy:/);
		expect(other.runs).toEqual([]);

		finish(CHECKS.map(() => pass()));
		expect((await first).isError).toBeUndefined();
		expect(places()).toBe(1);
		expect((await t.runChecks({})).isError).toBeUndefined();
	});

	it("hands a runner that throws back as check_run_failed, and gives its place back", async () => {
		const { runner } = recordingRunner(() => {
			throw new Error("docker create failed: no daemon");
		});
		const { t, places } = await tools({ runner });
		const out = await t.runChecks({});
		expect(out).toEqual({
			text: "check_run_failed: docker create failed: no daemon",
			isError: true,
		});
		expect(places()).toBe(1);
	});

	it("asks the session whether it was stopped before each check", async () => {
		let stopped = false;
		const { t, runs } = await tools({ stopped: () => stopped });
		await t.runChecks({});
		expect(runs[0]?.shouldStop?.()).toBe(false);
		stopped = true;
		expect(runs[0]?.shouldStop?.()).toBe(true);
	});

	it("refuses the report while a run is going, and files it once the run is back", async () => {
		let finish: (r: CheckRunResult[]) => void = () => {};
		const { runner, runs } = recordingRunner(
			() =>
				new Promise<CheckRunResult[]>((resolve) => {
					finish = resolve;
				}),
		);
		const { t, reports } = await tools({ runner });
		const checking = t.runChecks({});
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		const early = await t.report({ status: "complete", blockers: [] });
		expect(early.isError).toBe(true);
		expect(early.text).toMatch(/^checks_running:/);
		expect(reports()).toBe(0);

		finish(CHECKS.map(() => pass()));
		expect((await checking).isError).toBeUndefined();
		expect(
			(await t.report({ status: "complete", blockers: [] })).isError,
		).toBeUndefined();
		expect(reports()).toBe(1);
	});

	it("refuses once the report is filed", async () => {
		const { t, runs } = await tools();
		await t.report({ status: "complete", blockers: [] });
		const out = await t.runChecks({});
		expect(out.isError).toBe(true);
		expect(runs).toEqual([]);
	});
});

describe("AgentSdkHarness run_checks", () => {
	it("hands each session the room, its checks and the runner, and caps runs across sessions", async () => {
		let finish: (r: CheckRunResult[]) => void = () => {};
		const { runner, runs } = recordingRunner(
			() =>
				new Promise<CheckRunResult[]>((resolve) => {
					finish = resolve;
				}),
		);
		const h = new AgentSdkHarness({
			model: "claude-sonnet-5-5",
			apiKey: "sk-test",
			configDir: path.join(base, "config"),
			ids: sequentialIds(),
			logger: captureLogger().logger,
			clock: fixedClock(AT),
			checkRunner: runner,
			maxCheckRuns: 1,
			maxBudgetUsd: 2,
			maxTurns: 40,
			hostEnv: {},
			query: async function* () {},
		});
		h.bindAgentApi(async () => new Response(JSON.stringify({ success: true })));
		const session = async (): Promise<HarnessSession> => {
			const r = await room();
			return {
				dispatchId: r.id,
				token: "avl_dsp_secret",
				model: "claude-sonnet-5-5",
				roomRoot: r.root,
				writableGlobs: ["src/**"],
				roomRepoPath: r.dir,
				roomCommit: r.pinned,
				checks: [CHECKS[0] as RunnableCheck],
				identityMd: "# Kel\n",
				briefMd: "# M6\n",
				skills: [],
			};
		};
		const a = await session();
		const b = await session();
		expect(await h.start(a)).toBe(true);
		expect(await h.start(b)).toBe(true);

		const first = h.toolsFor(a.dispatchId)?.runChecks({});
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		expect(runs[0]?.source).toBe(a.roomRepoPath);
		expect(runs[0]?.parent).toBe(a.roomCommit);
		expect(runs[0]?.checks).toEqual([CHECKS[0]]);

		const busy = await h.toolsFor(b.dispatchId)?.runChecks({});
		expect(busy?.text).toMatch(/^runner_busy:/);

		finish([pass()]);
		expect((await first)?.isError).toBeUndefined();
		const later = h.toolsFor(b.dispatchId)?.runChecks({});
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		finish([pass()]);
		expect((await later)?.isError).toBeUndefined();
		expect(runs[1]?.source).toBe(b.roomRepoPath);
	});

	it("tells a stopped session's run to start no more checks", async () => {
		const { runner, runs } = recordingRunner(() => [pass()]);
		const h = new AgentSdkHarness({
			model: "claude-sonnet-5-5",
			apiKey: "sk-test",
			configDir: path.join(base, "config"),
			ids: sequentialIds(),
			logger: captureLogger().logger,
			clock: fixedClock(AT),
			checkRunner: runner,
			maxBudgetUsd: 2,
			maxTurns: 40,
			hostEnv: {},
			query: async function* () {},
		});
		h.bindAgentApi(async () => new Response(JSON.stringify({ success: true })));
		const r = await room();
		await h.start({
			dispatchId: r.id,
			token: "avl_dsp_secret",
			model: "claude-sonnet-5-5",
			roomRoot: r.root,
			writableGlobs: ["src/**"],
			roomRepoPath: r.dir,
			roomCommit: r.pinned,
			checks: CHECKS,
			identityMd: "# Kel\n",
			briefMd: "# M6\n",
			skills: [],
		});
		const t = h.toolsFor(r.id);
		await t?.runChecks({});
		expect(runs[0]?.shouldStop?.()).toBe(false);
		await h.stop(r.id);
		expect(runs[0]?.shouldStop?.()).toBe(true);
	});
});
