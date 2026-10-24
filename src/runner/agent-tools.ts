import { createHash } from "node:crypto";
import type {
	CheckRunner,
	CheckRunResult,
	RunnableCheck,
} from "../gateways/check-runner";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { snapshotRoomForChecks } from "../rooms/snapshot";
import {
	editTool,
	listTool,
	normalizeRoomPath,
	readBytesTool,
	ToolError,
	type ToolRoom,
	writeTool,
} from "../rooms/tools";
import type { SessionSkill } from "./harness";

/**
 * The tools a real agent gets (step 9d; docs/STEP-9-PLAN.md, The harness):
 * the room's four file tools, skill_read, run_checks, report and finding.
 * Nothing else reaches the host. Each handler returns the text the model sees and never
 * throws for a refusal: a refused call is the agent's to correct.
 *
 * report and finding go through the server's own /api/agent/* routes, in
 * process, with the dispatch's token. The token lives in this closure and
 * in no tool input or output, so the agent never sees it. What the agent
 * read is recorded here, by the read tool, and sent with the report: the
 * agent does not hash files or keep its own list.
 */

/** Calls the server in process: the app's fetch. */
export type AgentApi = (request: Request) => Promise<Response>;

export type ToolResult = { text: string; isError?: true };

/**
 * What run_checks needs (decided 2026-10-22: agents run their brief's
 * checks as advice, never gate evidence). The room is committed on its
 * pinned commit and the runner runs the checks on that commit, under the
 * same running-room rules as the gate's runs.
 */
export type AgentCheckContext = {
	/** The gate's runner. Null: run_checks refuses no_runner. */
	runner: CheckRunner | null;
	/** The room's source clone: the runner reads the commit from it. */
	source: string;
	/** The room's pinned commit: the parent of each run's commit. */
	commit: string;
	/** The checks the agent may run: its brief's, minus file_exists. */
	checks: readonly RunnableCheck[];
	/** Dates each run's commit. */
	clock: Clock;
	/**
	 * Takes one of the server's check-run places, or null when all are
	 * taken. The returned function gives it back.
	 */
	acquire: () => (() => void) | null;
	/** True once the session is stopped: the run starts no more checks. */
	stopped: () => boolean;
};

/** How much of each check's output the agent sees, from its end. */
export const CHECK_OUTPUT_CHARS = 4000;

export type AgentToolContext = {
	dispatchId: string;
	token: string;
	room: ToolRoom;
	skills: readonly SessionSkill[];
	api: AgentApi;
	ids: IdGenerator;
	/**
	 * Runs before the report is filed: hands the runner the usage it has
	 * not counted yet, because filing closes the dispatch and nothing is
	 * counted on a closed one.
	 */
	beforeReport: () => Promise<void>;
	/** Called once a report is filed, with its status. */
	onReported: (status: "complete" | "blocked") => void;
	run: AgentCheckContext;
};

export type Blocker = {
	description: string;
	workaround: string;
	provisioningGap: boolean;
};

const BASE = "http://avel.internal";

const ok = (text: string): ToolResult => ({ text });
const refused = (text: string): ToolResult => ({ text, isError: true });

function refusal(err: unknown): ToolResult {
	if (err instanceof ToolError)
		return refused(`${err.refusal}: ${err.message}`);
	throw err;
}

/** The answer's error message, for the agent. */
async function apiError(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as {
			error?: { code?: string; message?: string; details?: unknown };
		};
		const e = body.error ?? {};
		const details = e.details ? ` ${JSON.stringify(e.details)}` : "";
		return `${res.status} ${e.code ?? ""}: ${e.message ?? ""}${details}`.trim();
	} catch {
		return `${res.status}`;
	}
}

/** One check's result, as the agent reads it. */
function checkText(check: RunnableCheck, r: CheckRunResult | undefined) {
	const head = `## ${check.id} (${check.kind})`;
	if (!r) return `${head}: error, no result\n`;
	const exit = r.exitCode === null ? "no exit code" : `exit code ${r.exitCode}`;
	const out =
		r.output.length > CHECK_OUTPUT_CHARS
			? `(last ${CHECK_OUTPUT_CHARS} characters)\n${r.output.slice(-CHECK_OUTPUT_CHARS)}`
			: r.output;
	return [
		`${head}: ${r.outcome}, ${exit}`,
		check.command,
		"",
		out.trimEnd() || "(no output)",
		"",
	].join("\n");
}

export function agentTools(ctx: AgentToolContext) {
	/** Every path read, in first-read order, at the sha of its latest read. */
	const reads = new Map<string, string>();
	let rereads = 0;
	let reported = false;
	let checking = false;

	const call = (
		path: string,
		init: { method: string; body: unknown; key?: string },
	) =>
		ctx.api(
			new Request(`${BASE}${path}`, {
				method: init.method,
				headers: {
					authorization: `Bearer ${ctx.token}`,
					"content-type": "application/json",
					...(init.key ? { "idempotency-key": init.key } : {}),
				},
				body: JSON.stringify(init.body),
			}),
		);

	return {
		/** What the report will say was read. */
		artifactsRead: () => [...reads].map(([path, sha256]) => ({ path, sha256 })),
		rereads: () => rereads,

		async roomRead(input: { path: string }): Promise<ToolResult> {
			try {
				const bytes = await readBytesTool(ctx.room, input.path);
				const path = normalizeRoomPath(input.path);
				if (reads.has(path)) rereads += 1;
				reads.set(path, createHash("sha256").update(bytes).digest("hex"));
				return ok(bytes.toString("utf8"));
			} catch (err) {
				return refusal(err);
			}
		},

		async roomList(input: { path?: string }): Promise<ToolResult> {
			try {
				const entries = await listTool(ctx.room, input.path ?? "");
				return ok(
					entries
						.map((e) => (e.kind === "directory" ? `${e.name}/` : e.name))
						.join("\n") || "(empty)",
				);
			} catch (err) {
				return refusal(err);
			}
		},

		async roomWrite(input: {
			path: string;
			content: string;
		}): Promise<ToolResult> {
			try {
				await writeTool(ctx.room, input.path, input.content);
				return ok(`Wrote ${normalizeRoomPath(input.path)}`);
			} catch (err) {
				return refusal(err);
			}
		},

		async roomEdit(input: {
			path: string;
			oldText: string;
			newText: string;
		}): Promise<ToolResult> {
			try {
				await editTool(ctx.room, input.path, input.oldText, input.newText);
				return ok(`Edited ${normalizeRoomPath(input.path)}`);
			} catch (err) {
				return refusal(err);
			}
		},

		async skillRead(input: { slug: string }): Promise<ToolResult> {
			const s = ctx.skills.find((x) => x.slug === input.slug);
			if (!s) {
				const known = ctx.skills.map((x) => x.slug).join(", ") || "none";
				return refused(`No skill ${input.slug} in your brief. Yours: ${known}`);
			}
			return ok(s.contentMd);
		},

		/**
		 * Runs the brief's checks on the room's files as they are now:
		 * every runnable check, or the ones named. Advice only. The gate
		 * runs its own checks on the integration commit.
		 */
		async runChecks(input: { checkIds?: string[] }): Promise<ToolResult> {
			const run = ctx.run;
			if (reported) return refused("Your report is already filed. Stop now.");
			if (run.checks.length === 0) {
				return refused(
					"no_checks: Your brief lists no test, typecheck or command check. The gate judges file_exists checks from your changes.",
				);
			}
			const known = run.checks.map((c) => c.id).join(", ");
			const wanted = input.checkIds?.length ? new Set(input.checkIds) : null;
			const unknown = [...(wanted ?? [])].filter(
				(id) => !run.checks.some((c) => c.id === id),
			);
			if (unknown.length > 0) {
				return refused(
					`unknown_check: ${unknown.join(", ")} is not a check run_checks can run. Yours: ${known}`,
				);
			}
			if (!run.runner) {
				return refused(
					"no_runner: No check runner is installed, so your checks cannot run here. The gate reports them as not run.",
				);
			}
			if (checking) {
				return refused(
					"already_running: Your checks are already running. Wait for that result.",
				);
			}
			const release = run.acquire();
			if (!release) {
				return refused(
					"runner_busy: Every check-run place is taken. Keep working and try again later.",
				);
			}
			checking = true;
			try {
				const checks = run.checks.filter((c) => !wanted || wanted.has(c.id));
				let commitSha: string;
				let results: CheckRunResult[];
				try {
					commitSha = await snapshotRoomForChecks(
						ctx.room,
						run.commit,
						ctx.dispatchId,
						run.clock.now().toISOString(),
					);
					results = await run.runner.run({
						source: run.source,
						commitSha,
						checks,
						shouldStop: run.stopped,
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return refused(`check_run_failed: ${message}`);
				}
				const passed = results.filter((r) => r.outcome === "pass").length;
				return ok(
					[
						"Advice only. The gate runs its own checks on the integration commit, and these results are not evidence.",
						`${passed} of ${checks.length} passed, on your room's files as they are now (commit ${commitSha}).`,
						"",
						...checks.map((c, i) => checkText(c, results[i])),
					].join("\n"),
				);
			} finally {
				checking = false;
				release();
			}
		},

		async report(input: {
			status: "complete" | "blocked";
			blockers: Blocker[];
		}): Promise<ToolResult> {
			if (reported) return refused("Your report is already filed. Stop now.");
			// Filing closes the dispatch: a run still going would hold its
			// place with no one to read its result.
			if (checking) {
				return refused(
					"checks_running: Your checks are still running. Wait for their result, then report.",
				);
			}
			await ctx.beforeReport();
			const res = await call("/api/agent/report", {
				method: "POST",
				body: {
					status: input.status,
					artifactsRead: [...reads].map(([path, sha256]) => ({ path, sha256 })),
					blockers: input.blockers,
					rereads,
				},
			});
			if (res.status !== 201) return refused(await apiError(res));
			reported = true;
			ctx.onReported(input.status);
			return ok("Report filed. Your work on this dispatch is over. Stop now.");
		},

		async finding(input: {
			rule: string;
			subject: string;
			severity: "critical" | "high" | "medium" | "low";
			class: string;
		}): Promise<ToolResult> {
			const res = await call("/api/agent/findings", {
				method: "POST",
				body: input,
				key: ctx.ids.next(),
			});
			if (res.status !== 201 && res.status !== 200) {
				return refused(await apiError(res));
			}
			return ok("Finding recorded.");
		},
	};
}

export type AgentTools = ReturnType<typeof agentTools>;
