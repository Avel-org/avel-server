import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/lib/clock";
import { sequentialIds } from "../../src/lib/ids";
import { AgentSdkHarness } from "../../src/runner/agent-sdk-harness";
import { FakeCanonModel } from "../../src/runner/canon";
import { AgentSdkCanonModel } from "../../src/runner/canon/sdk-model";
import { FakeHarness } from "../../src/runner/harness";
import {
	intervalFromEnv,
	startBlobSweepLoop,
	startCanonLoop,
	startRunnerLoop,
} from "../../src/runner/loop";
import type { RunnerDeps, SweepResult } from "../../src/runner/runner";
import { harnessFromEnv, shutdown } from "../../src/runner/wiring";
import { captureLogger } from "./support";

// The loops and the server's wiring, with fake timers and no database. The
// loops' real sweep and tick run against a database in
// tests/api/runner-loop.test.ts.

const nothing: SweepResult = { halted: [], failed: [] };
// The loop hands deps through untouched; these tests never read them.
const deps = {} as RunnerDeps;

/** A step that records each call and resolves when released, one at a time. */
function gated() {
	const calls: number[] = [];
	const gates: Array<() => void> = [];
	const step = async () => {
		calls.push(calls.length + 1);
		await new Promise<void>((resolve) => gates.push(resolve));
		return nothing;
	};
	const release = () => gates.shift()?.();
	return { calls, step, release };
}

describe("startRunnerLoop", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sweeps once at startup, then ticks every interval", async () => {
		const order: string[] = [];
		const { logger } = captureLogger();
		const stop = startRunnerLoop(deps, {
			intervalMs: 1000,
			logger,
			sweep: async () => {
				order.push("sweep");
				return nothing;
			},
			tick: async () => {
				order.push("tick");
				return nothing;
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["sweep"]);
		await vi.advanceTimersByTimeAsync(999);
		expect(order).toEqual(["sweep"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(order).toEqual(["sweep", "tick"]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(order).toEqual(["sweep", "tick", "tick", "tick", "tick"]);
		await stop();
	});

	it("never starts a tick while the last step is still running", async () => {
		const { logger } = captureLogger();
		const sweep = gated();
		const tick = gated();
		const stop = startRunnerLoop(deps, {
			intervalMs: 100,
			logger,
			sweep: sweep.step,
			tick: tick.step,
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect([sweep.calls.length, tick.calls.length]).toEqual([1, 0]);
		sweep.release();
		await vi.advanceTimersByTimeAsync(100);
		expect(tick.calls).toEqual([1]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(tick.calls).toEqual([1]);
		tick.release();
		await vi.advanceTimersByTimeAsync(100);
		expect(tick.calls).toEqual([1, 2]);
		tick.release();
		await stop();
	});

	it("logs a step that throws, and runs the next one", async () => {
		const { logger, lines } = captureLogger();
		let ticks = 0;
		const stop = startRunnerLoop(deps, {
			intervalMs: 100,
			logger,
			sweep: async () => {
				throw new Error("database gone");
			},
			tick: async () => {
				ticks += 1;
				if (ticks === 1) throw new Error("tick broke");
				return nothing;
			},
		});
		await vi.advanceTimersByTimeAsync(300);
		expect(ticks).toBe(3);
		expect(
			lines.filter((l) => l.msg === "runner tick failed").map((l) => l.err),
		).toEqual(["database gone", "tick broke"]);
		await stop();
	});

	it("logs the dispatches a step closed, and nothing when it closed none", async () => {
		const { logger, lines } = captureLogger();
		const stop = startRunnerLoop(deps, {
			intervalMs: 100,
			logger,
			sweep: async () => ({ halted: ["d1"], failed: [] }),
			tick: async () => nothing,
		});
		await vi.advanceTimersByTimeAsync(300);
		const closed = lines.filter((l) => l.msg === "runner closed dispatches");
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({ halted: ["d1"], failed: [] });
		await stop();
	});

	it("stops: no step starts after it, and it resolves only once the step in flight ends", async () => {
		const { logger } = captureLogger();
		const tick = gated();
		const stop = startRunnerLoop(deps, {
			intervalMs: 100,
			logger,
			sweep: async () => nothing,
			tick: tick.step,
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(tick.calls).toEqual([1]);
		let stopped = false;
		const stopping = stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(stopped).toBe(false);
		tick.release();
		await stopping;
		expect(stopped).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(tick.calls).toEqual([1]);
	});

	it("does not hold the process open", () => {
		const { logger } = captureLogger();
		const unref = vi.spyOn(globalThis, "setInterval");
		const stop = startRunnerLoop(deps, {
			intervalMs: 100,
			logger,
			sweep: async () => nothing,
			tick: async () => nothing,
		});
		const timer = unref.mock.results[0]?.value as NodeJS.Timeout;
		expect(timer.hasRef()).toBe(false);
		unref.mockRestore();
		return stop();
	});
});

describe("startCanonLoop", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const canonDeps = {} as Parameters<typeof startCanonLoop>[0];

	it("runs nothing at startup, ticks every interval, logs the turns it ran and a tick that throws", async () => {
		const { logger, lines } = captureLogger();
		let ticks = 0;
		const stop = startCanonLoop(canonDeps, {
			intervalMs: 3000,
			logger,
			tick: async () => {
				ticks += 1;
				if (ticks === 2) throw new Error("model down");
				return ticks === 3 ? [{ outcome: "replied", promptSha256: "a" }] : [];
			},
		});
		await vi.advanceTimersByTimeAsync(2999);
		expect(ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(6001);
		expect(ticks).toBe(3);
		expect(lines.map((l) => l.msg)).toEqual([
			"canon tick failed",
			"canon turns ran",
		]);
		await stop();
		await vi.advanceTimersByTimeAsync(9000);
		expect(ticks).toBe(3);
	});
});

describe("startBlobSweepLoop", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const sweepDeps = {} as Parameters<typeof startBlobSweepLoop>[0];

	it("sweeps at startup and every interval, logs only a sweep that removed something, and does not hold the process open", async () => {
		const { logger, lines } = captureLogger();
		const results = [
			{ removed: [], kept: 2, temps: 0 },
			{ removed: ["general/a"], kept: 0, temps: 1 },
		];
		let sweeps = 0;
		const interval = vi.spyOn(globalThis, "setInterval");
		const stop = startBlobSweepLoop(sweepDeps, {
			intervalMs: 1000,
			logger,
			sweep: async () => {
				sweeps += 1;
				return results[sweeps - 1] ?? { removed: [], kept: 0, temps: 0 };
			},
		});
		const timer = interval.mock.results[0]?.value as NodeJS.Timeout;
		interval.mockRestore();
		expect(timer.hasRef()).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(sweeps).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(sweeps).toBe(2);
		expect(lines.filter((l) => l.msg === "orphan blobs swept")).toMatchObject([
			{ removed: 1, temps: 1 },
		]);
		await stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(sweeps).toBe(2);
	});
});

describe("intervalFromEnv", () => {
	it("takes the fallback when unset or empty, and a positive whole number of milliseconds", () => {
		expect(intervalFromEnv("X", undefined, 5000)).toBe(5000);
		expect(intervalFromEnv("X", "", 5000)).toBe(5000);
		expect(intervalFromEnv("X", "250", 5000)).toBe(250);
	});

	it("refuses anything else, which setInterval would read as about a millisecond", () => {
		for (const bad of ["abc", "0", "-5", "1.5", "5s", "Infinity"]) {
			expect(() =>
				intervalFromEnv("AVEL_RUNNER_INTERVAL_MS", bad, 5000),
			).toThrow(
				"AVEL_RUNNER_INTERVAL_MS must be a positive whole number of milliseconds",
			);
		}
	});
});

describe("harnessFromEnv", () => {
	const options = () => ({
		stateDir: path.join("state", "avel"),
		ids: sequentialIds(),
		logger: captureLogger().logger,
		clock: fixedClock("2026-10-23T09:00:00.000Z"),
		checkRunner: null,
	});

	it("runs the FakeHarness and the offline Canon model unless AVEL_HARNESS is agent-sdk", () => {
		for (const value of [undefined, "", "fake", "AGENT-SDK", "agent_sdk"]) {
			const env: NodeJS.ProcessEnv = {
				AVEL_HARNESS: value,
				ANTHROPIC_API_KEY: "sk-test",
			};
			const chosen = harnessFromEnv(env, options());
			expect(chosen.harness, String(value)).toBeInstanceOf(FakeHarness);
			expect(chosen.sdk).toBeNull();
			expect(chosen.canonModel).toBeInstanceOf(FakeCanonModel);
			// The key is left alone when nothing reads it.
			expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
		}
	});

	it("refuses agent-sdk without ANTHROPIC_API_KEY", () => {
		for (const key of [undefined, ""]) {
			expect(() =>
				harnessFromEnv(
					{ AVEL_HARNESS: "agent-sdk", ANTHROPIC_API_KEY: key },
					options(),
				),
			).toThrow("AVEL_HARNESS=agent-sdk needs ANTHROPIC_API_KEY");
		}
	});

	it("runs the Agent SDK for dispatches and Canon on agent-sdk, and takes the key out of the environment", () => {
		const env: NodeJS.ProcessEnv = {
			AVEL_HARNESS: "agent-sdk",
			ANTHROPIC_API_KEY: "sk-test",
		};
		const chosen = harnessFromEnv(env, options());
		expect(chosen.harness).toBeInstanceOf(AgentSdkHarness);
		expect(chosen.sdk).toBe(chosen.harness);
		expect(chosen.harness.model).toBe("claude-sonnet-5-5");
		expect(chosen.harness.version).toBe("claude-agent-sdk@0.3.296");
		expect(chosen.canonModel).toBeInstanceOf(AgentSdkCanonModel);
		expect("ANTHROPIC_API_KEY" in env).toBe(false);
	});

	it("runs AVEL_HARNESS_MODEL when set", () => {
		const chosen = harnessFromEnv(
			{
				AVEL_HARNESS: "agent-sdk",
				ANTHROPIC_API_KEY: "sk-test",
				AVEL_HARNESS_MODEL: "claude-opus-5-5",
			},
			options(),
		);
		expect(chosen.harness.model).toBe("claude-opus-5-5");
	});
});

describe("shutdown", () => {
	it("stops every loop and waits for it, then closes the server, then the database", async () => {
		const { logger } = captureLogger();
		const order: string[] = [];
		let releaseLoop!: () => void;
		const loopDone = new Promise<void>((r) => {
			releaseLoop = r;
		});
		const done = shutdown({
			stops: [
				async () => {
					order.push("stop runner");
					await loopDone;
					order.push("runner stopped");
				},
				async () => {
					order.push("stop canon");
				},
			],
			server: {
				close: (cb) => {
					order.push("close server");
					cb();
				},
			},
			closeDb: async () => {
				order.push("close db");
			},
			logger,
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(order).toEqual(["stop runner", "stop canon"]);
		releaseLoop();
		expect(await done).toBe(0);
		expect(order).toEqual([
			"stop runner",
			"stop canon",
			"runner stopped",
			"close server",
			"close db",
		]);
	});

	it("answers 1 and logs when a step outlasts the timeout", async () => {
		const { logger, lines } = captureLogger();
		const code = await shutdown({
			stops: [() => new Promise<void>(() => {})],
			server: { close: (cb) => cb() },
			closeDb: async () => {},
			logger,
			timeoutMs: 20,
		});
		expect(code).toBe(1);
		expect(lines.map((l) => l.msg)).toContain("shutdown timed out");
	});

	it("answers 1 and logs when closing fails", async () => {
		const { logger, lines } = captureLogger();
		const code = await shutdown({
			stops: [],
			server: { close: (cb) => cb(new Error("not running")) },
			closeDb: async () => {},
			logger,
		});
		expect(code).toBe(1);
		expect(lines.find((l) => l.msg === "shutdown failed")?.err).toBe(
			"not running",
		);
	});
});
