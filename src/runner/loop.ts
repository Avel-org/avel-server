import {
	type BlobSweepDeps,
	type BlobSweepResult,
	sweepOrphanBlobs,
} from "../db/blob-sweep";
import type { Logger } from "../lib/logger";
import { type CanonDeps, canonTick } from "./canon";
import { type RunnerDeps, type SweepResult, sweep, tick } from "./runner";

/**
 * The loops that tick in the server's own process (step 9d). A step never
 * overlaps the last one; a step that throws is logged and the next one
 * runs. Each start returns a stop function, which clears the timer and
 * resolves once the step in flight, if any, has ended, so a shutdown never
 * cuts a step's transaction short.
 */

/** Stops a loop: no step starts after it, and it resolves when the last one ends. */
export type StopLoop = () => Promise<void>;

type LoopOptions = { intervalMs: number; logger: Logger };

function startLoop(
	name: string,
	options: LoopOptions & { unref: boolean },
	first: (() => Promise<void>) | null,
	step: () => Promise<void>,
): StopLoop {
	const { logger } = options;
	let inFlight: Promise<void> | null = null;
	let stopped = false;
	const once = (run: () => Promise<void>) => {
		if (inFlight || stopped) return;
		inFlight = run()
			.catch((err) => {
				logger.error(
					{ err: err instanceof Error ? err.message : String(err) },
					`${name} tick failed`,
				);
			})
			.finally(() => {
				inFlight = null;
			});
	};
	if (first) once(first);
	const timer = setInterval(() => once(step), options.intervalMs);
	if (options.unref) timer.unref();
	return async () => {
		stopped = true;
		clearInterval(timer);
		await inFlight;
	};
}

/**
 * The runner's loop: sweeps once at startup, so a dispatch past its wall
 * clock or left without a session by a restart closes at once, then ticks
 * every `intervalMs`. Only started when a real harness is configured. The
 * timer does not hold the process open. `sweep` and `tick` are the
 * runner's; tests pass their own.
 */
export function startRunnerLoop(
	deps: RunnerDeps,
	options: LoopOptions & {
		sweep?: (d: RunnerDeps) => Promise<SweepResult>;
		tick?: (d: RunnerDeps) => Promise<SweepResult>;
	},
): StopLoop {
	const { logger } = options;
	const logClosed = (result: SweepResult) => {
		if (result.halted.length > 0 || result.failed.length > 0) {
			logger.info(result, "runner closed dispatches");
		}
	};
	const doSweep = options.sweep ?? sweep;
	const doTick = options.tick ?? tick;
	return startLoop(
		"runner",
		{ ...options, unref: true },
		async () => logClosed(await doSweep(deps)),
		async () => logClosed(await doTick(deps)),
	);
}

/**
 * Canon's loop: a posted operator message starts a turn, and this answers
 * it every `intervalMs`. It always runs, model or not, because nothing else
 * ends a turn. `tick` is canonTick; tests pass their own.
 */
export function startCanonLoop(
	deps: CanonDeps,
	options: LoopOptions & { tick?: typeof canonTick },
): StopLoop {
	const { logger } = options;
	const doTick = options.tick ?? canonTick;
	return startLoop("canon", { ...options, unref: false }, null, async () => {
		const results = await doTick(deps);
		if (results.length > 0) logger.info({ results }, "canon turns ran");
	});
}

/**
 * The orphan blob sweep's loop (src/db/blob-sweep.ts): sweeps once at
 * startup, then every `intervalMs`. The timer does not hold the process
 * open. `sweep` is sweepOrphanBlobs; tests pass their own.
 */
export function startBlobSweepLoop(
	deps: BlobSweepDeps,
	options: LoopOptions & {
		sweep?: (d: BlobSweepDeps) => Promise<BlobSweepResult>;
	},
): StopLoop {
	const { logger } = options;
	const doSweep = options.sweep ?? sweepOrphanBlobs;
	const once = async () => {
		const result = await doSweep(deps);
		if (result.removed.length > 0 || result.temps > 0) {
			logger.info(
				{ removed: result.removed.length, temps: result.temps },
				"orphan blobs swept",
			);
		}
	};
	return startLoop("blob sweep", { ...options, unref: true }, once, once);
}

/**
 * A loop interval from the environment: `fallback` when unset or empty,
 * else a positive whole number of milliseconds. Anything else refuses to
 * start the server: setInterval reads NaN or 0 as about a millisecond, so
 * a typo would spin the loop against the database.
 */
export function intervalFromEnv(
	name: string,
	value: string | undefined,
	fallback: number,
): number {
	if (value === undefined || value === "") return fallback;
	const ms = Number(value);
	if (!Number.isSafeInteger(ms) || ms <= 0) {
		throw new Error(`${name} must be a positive whole number of milliseconds`);
	}
	return ms;
}
