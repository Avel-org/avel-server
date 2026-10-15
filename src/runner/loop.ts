import type { Logger } from "../lib/logger";
import { type RunnerDeps, sweep, tick } from "./runner";

/**
 * The runner ticking in the server's own process (step 9d). Sweeps once at
 * startup, then ticks every `intervalMs`. A tick never overlaps the last
 * one; a tick that throws is logged and the next one runs. Returns a stop
 * function. Only started when a real harness is configured.
 */
export function startRunnerLoop(
	deps: RunnerDeps,
	options: { intervalMs: number; logger: Logger },
): () => void {
	const { logger } = options;
	let busy = false;
	let stopped = false;
	const once = async (step: (d: RunnerDeps) => Promise<unknown>) => {
		if (busy || stopped) return;
		busy = true;
		try {
			const result = await step(deps);
			if (
				result &&
				typeof result === "object" &&
				"halted" in result &&
				"failed" in result &&
				((result.halted as string[]).length > 0 ||
					(result.failed as string[]).length > 0)
			) {
				logger.info(result, "runner closed dispatches");
			}
		} catch (err) {
			logger.error(
				{ err: err instanceof Error ? err.message : String(err) },
				"runner tick failed",
			);
		} finally {
			busy = false;
		}
	};
	void once(sweep);
	const timer = setInterval(() => void once(tick), options.intervalMs);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
