import type { BriefCheck } from "../contract/intake";

/** A brief check that needs a runner: everything but file_exists. */
export type RunnableCheck = Exclude<BriefCheck, { kind: "file_exists" }>;

/** What a runner is asked to do: run each check against one commit of a local clone. */
export type CheckRunRequest = {
	/** The local clone the commit is in (AVEL_SOURCES_DIR). The runner copies it; it never writes there. */
	source: string;
	/** A full commit sha: the gate's integration commit. */
	commitSha: string;
	checks: readonly RunnableCheck[];
	/**
	 * Called before each check with how many are done and the index (in
	 * `checks`) of the one starting, and once at the end with null. Awaited,
	 * so a slow write holds the next check, never races it.
	 */
	onProgress?: (checksDone: number, current: number | null) => Promise<void>;
	/**
	 * Asked before each check. True stops the run: the checks not yet run
	 * are errors. A gate job past its time limit, or a stopped agent
	 * session.
	 */
	shouldStop?: () => boolean;
	/**
	 * Aborted, the run ends at once: the install or check in flight is
	 * killed, and every check not finished is an error. A stopped agent
	 * session's run_checks.
	 */
	signal?: AbortSignal;
};

/**
 * One check's result. `pass` is exit code 0 and `fail` any other exit;
 * `error` is a check that could not finish (a timeout, the runner itself
 * breaking), with `exitCode` null. `output` is the end of what the command
 * printed, capped by the runner.
 */
export type CheckRunResult = {
	outcome: "pass" | "fail" | "error";
	exitCode: number | null;
	output: string;
};

/**
 * Where the gate's test, typecheck and command checks run (decided
 * 2026-10-22: local Docker first, under SANDBOX.md's running-room rules).
 * `run` answers one result per check, in the order asked. `id` names the
 * runner and what it ran in (an image digest, say), and goes into the
 * receipt. AppDeps carries null when no runner is installed, and the gate
 * then reports those checks not_run, as before.
 */
export interface CheckRunner {
	readonly id: string;
	run(request: CheckRunRequest): Promise<CheckRunResult[]>;
	/**
	 * At startup: removes what a run left when the server stopped in the
	 * middle of it (containers, for Docker). Assumes one server process.
	 */
	sweep?(): Promise<void>;
}

/**
 * The brief checks a runner runs: every one but file_exists, which the gate
 * judges from the work's changes. One rule for the gate and run_checks.
 */
export function runnableChecks(checks: readonly BriefCheck[]): RunnableCheck[] {
	return checks.filter((c): c is RunnableCheck => c.kind !== "file_exists");
}
