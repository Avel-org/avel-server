import path from "node:path";
import type { CheckRunner } from "../gateways/check-runner";
import type { AgentRooms } from "../gateways/docker-agent-rooms";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import type { Logger } from "../lib/logger";
import { AgentSdkHarness, type QueryFn } from "./agent-sdk-harness";
import { type CanonModel, offlineCanonModel } from "./canon";
import { AgentSdkCanonModel } from "./canon/sdk-model";
import { FakeHarness, type Harness } from "./harness";
import { type StopLoop, startRunnerLoop } from "./loop";
import { applyUsage, type RunnerDeps, writeDispatchStep } from "./runner";

/**
 * The harness and Canon's model the server runs with (step 9d), from its
 * environment. The FakeHarness and the offline Canon model unless
 * AVEL_HARNESS=agent-sdk, which runs real agents on the Claude Agent SDK
 * and spends real money; it refuses to start without ANTHROPIC_API_KEY,
 * and without agent rooms (AVEL_AGENT_IMAGE), so no agent's process runs on
 * this host holding the key (decided 2026-10-24, required 2026-10-27).
 * The key is taken out of `env` once read, so no other child process
 * (git) inherits it. Any other AVEL_HARNESS value keeps the FakeHarness,
 * as .env.example says.
 */
export type ServerHarness = {
	harness: Harness;
	/** The real harness, when on: the server binds it and ticks the runner. */
	sdk: AgentSdkHarness | null;
	canonModel: CanonModel;
};

/**
 * AVEL_MAX_CHECK_RUNS: how many agents' run_checks runs may go at once,
 * each a container with the runner's caps. The gate's job, one at a time,
 * is one more. Unset is 2 (`[hypothesis]`); anything but a positive whole
 * number refuses to start the server.
 */
export function checkRunsFromEnv(value: string | undefined): number {
	if (value === undefined || value === "") return 2;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n <= 0) {
		throw new Error("AVEL_MAX_CHECK_RUNS must be a positive whole number");
	}
	return n;
}

/** A dollar backstop: unset or empty is the default; anything but a positive number refuses to start. */
function dollarsFromEnv(
	name: string,
	value: string | undefined,
	fallback: number,
): number {
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`${name} must be a positive number of dollars`);
	}
	return n;
}

/** A turn backstop: unset or empty is the default; anything but a positive whole number refuses to start. */
function turnsFromEnv(
	name: string,
	value: string | undefined,
	fallback: number,
): number {
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n <= 0) {
		throw new Error(`${name} must be a positive whole number`);
	}
	return n;
}

export function harnessFromEnv(
	env: NodeJS.ProcessEnv,
	options: {
		/** The parent of the rooms directory: the SDK config dirs go beside it. */
		stateDir: string;
		ids: IdGenerator;
		logger: Logger;
		clock: Clock;
		/** The gate's check runner: the agents' run_checks uses it too. */
		checkRunner: CheckRunner | null;
		/** Where agents' processes run; agent-sdk refuses to start without them. */
		agentRooms?: AgentRooms | null;
		/** The SDK's query; tests pass a scripted one. */
		query?: QueryFn;
	},
): ServerHarness {
	if (env.AVEL_HARNESS !== "agent-sdk") {
		return {
			harness: new FakeHarness(),
			sdk: null,
			canonModel: offlineCanonModel(),
		};
	}
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error("AVEL_HARNESS=agent-sdk needs ANTHROPIC_API_KEY");
	}
	const agentRooms = options.agentRooms ?? null;
	if (!agentRooms) {
		throw new Error(
			"AVEL_HARNESS=agent-sdk needs AVEL_AGENT_IMAGE: no agent runs on this host",
		);
	}
	delete env.ANTHROPIC_API_KEY;
	const { logger } = options;
	const sdk = new AgentSdkHarness({
		model: env.AVEL_HARNESS_MODEL || "claude-sonnet-5-5",
		apiKey,
		configDir: path.join(options.stateDir, "runner-config"),
		ids: options.ids,
		logger,
		clock: options.clock,
		checkRunner: options.checkRunner,
		agentRooms,
		maxBudgetUsd: dollarsFromEnv(
			"AVEL_HARNESS_MAX_BUDGET_USD",
			env.AVEL_HARNESS_MAX_BUDGET_USD,
			2,
		),
		maxTurns: turnsFromEnv(
			"AVEL_HARNESS_MAX_TURNS",
			env.AVEL_HARNESS_MAX_TURNS,
			60,
		),
		maxCheckRuns: checkRunsFromEnv(env.AVEL_MAX_CHECK_RUNS),
		...(options.query ? { query: options.query } : {}),
	});
	const canonModel = new AgentSdkCanonModel({
		apiKey,
		configDir: path.join(options.stateDir, "canon-config"),
		logger,
		maxBudgetUsd: dollarsFromEnv(
			"AVEL_CANON_MAX_BUDGET_USD",
			env.AVEL_CANON_MAX_BUDGET_USD,
			1,
		),
		maxTurns: turnsFromEnv(
			"AVEL_CANON_MAX_TURNS",
			env.AVEL_CANON_MAX_TURNS,
			30,
		),
	});
	return { harness: sdk, sdk, canonModel };
}

/**
 * Binds the real harness to the app and the runner, then starts the
 * runner's loop. Report and finding go through the app itself, in
 * process; usage and trace steps go to the runner with its own deps.
 */
export function startRealRunner(
	sdk: AgentSdkHarness,
	fetch: (request: Request) => Response | Promise<Response>,
	deps: RunnerDeps,
	options: Parameters<typeof startRunnerLoop>[1],
): StopLoop {
	sdk.bindAgentApi((request) => Promise.resolve(fetch(request)));
	sdk.bindUsageSink((id, split) => applyUsage(deps, id, split));
	sdk.bindStepSink((id, step) => writeDispatchStep(deps, id, step));
	return startRunnerLoop(deps, options);
}

/**
 * The server's shutdown: stops every loop and waits for the steps in
 * flight, stops taking requests and waits for those open, then closes the
 * database. 0 when all of it finished within `timeoutMs`, else 1, with the
 * reason logged; the caller exits with it either way.
 */
export async function shutdown(parts: {
	stops: readonly StopLoop[];
	server: { close: (done: (err?: Error) => void) => unknown };
	closeDb: () => Promise<void>;
	logger: Logger;
	timeoutMs?: number;
}): Promise<0 | 1> {
	const { logger } = parts;
	const timeoutMs = parts.timeoutMs ?? 10_000;
	const work = (async () => {
		await Promise.all(parts.stops.map((stop) => stop()));
		await new Promise<void>((resolve, reject) =>
			parts.server.close((err) => (err ? reject(err) : resolve())),
		);
		await parts.closeDb();
	})();
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		if ((await Promise.race([work, timedOut])) === "timeout") {
			logger.error({ timeoutMs }, "shutdown timed out");
			return 1;
		}
		logger.info("shut down");
		return 0;
	} catch (err) {
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"shutdown failed",
		);
		return 1;
	} finally {
		clearTimeout(timer);
	}
}
