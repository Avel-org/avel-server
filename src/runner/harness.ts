import type { RunStep } from "../contract";
import type { TokenSplit } from "../lib/prices";

/**
 * The harness plug (module 6, COMMAND-CENTER §6): what actually runs an
 * agent's model. The runner drives it and never trusts it with the budget:
 * the harness reports usage, and the runner counts it, prices it and stops
 * it (SANDBOX.md, The runner enforces budget). An AppDeps gateway, like the
 * repo and template sources. The FakeHarness runs no model and is the
 * default and the tests' harness; AgentSdkHarness (agent-sdk-harness.ts)
 * runs a real one when AVEL_HARNESS=agent-sdk.
 */

/**
 * One step of the session's work, for the run trace (J, 2026-10-20): the
 * agent's text, a reasoning summary, a tool call or its result, or an error.
 * The runner writes it as a dispatch_step; it never touches the budget.
 */
export type HarnessStep = Pick<RunStep, "kind" | "label" | "detail">;

/** What a running session reports, read one at a time by the runner. */
export type HarnessEvent =
	/** A step of the work, for the trace. */
	| { kind: "step"; step: HarnessStep }
	/** Tokens spent since the last event, to add to the dispatch's counts. */
	| { kind: "usage"; split: TokenSplit }
	/** The agent says it finished. Its own report closes the dispatch (step 8). */
	| { kind: "complete" }
	/** The agent says it is blocked. Its own report closes the dispatch (step 8). */
	| { kind: "blocked" }
	/** The session died. The runner closes the dispatch as failed. */
	| { kind: "fail" };

/** A skill the session's agent may read in full by its slug. */
export type SessionSkill = { slug: string; contentMd: string };

/** What the runner hands the harness to start a session. */
export type HarnessSession = {
	dispatchId: string;
	/** The dispatch's access token, in the clear. Only the harness holds it. */
	token: string;
	model: string;
	/** The dispatch's room (src/rooms): where the agent's file tools work. */
	roomRoot: string;
	/** The room's resolved writable globs: where write and edit may go. */
	writableGlobs: readonly string[];
	/** The agent's identity, from the version frozen at start. */
	identityMd: string;
	/** The brief frozen at start; null for a dispatch with no briefRef. */
	briefMd: string | null;
	/** The dispatch's stack and domain skills, the brief's Method. */
	skills: readonly SessionSkill[];
};

export type Harness = {
	/** The model this harness runs: what a dispatch freezes and is priced by. */
	readonly model: string;
	/** The harness and its version, such as claude-agent-sdk@0.3.296: dispatch.harness_version. */
	readonly version: string;
	/** Starts a session; false when the harness cannot take it now. */
	start: (session: HarnessSession) => Promise<boolean>;
	/** Whether a session for this dispatch exists, e.g. after a restart. */
	has: (dispatchId: string) => Promise<boolean>;
	/** The session's next event, or null when it has none now. */
	next: (dispatchId: string) => Promise<HarnessEvent | null>;
	/** Stops the session. Stopping one that does not exist does nothing. */
	stop: (dispatchId: string) => Promise<void>;
};

/** The FakeHarness's model id. src/lib/prices.ts prices it at zero. */
export const FAKE_HARNESS_MODEL = "fake-harness";

/** The FakeHarness's harness_version. */
export const FAKE_HARNESS_VERSION = "fake-harness@1";

/**
 * A FakeHarness script: usage steps reported in order, then the outcome.
 * `until_stopped` reports nothing more and runs until the runner stops it.
 */
export type FakeScript = {
	steps: readonly TokenSplit[];
	outcome: "complete" | "blocked" | "fail" | "until_stopped";
	/** Trace steps reported before the usage, in order. */
	trace?: readonly HarnessStep[];
};

const IDLE: FakeScript = { steps: [], outcome: "until_stopped" };

/**
 * A harness that runs no model: each session plays a script. Tests script a
 * dispatch before starting it; an unscripted session runs until stopped.
 * `restart()` forgets every session, as a process restart would.
 */
export class FakeHarness implements Harness {
	readonly model: string;
	readonly version = FAKE_HARNESS_VERSION;
	/** False makes every start refuse, as a harness at capacity would. */
	accepting = true;
	private readonly scripts = new Map<string, FakeScript>();
	private readonly sessions = new Map<
		string,
		{ session: HarnessSession; events: HarnessEvent[] }
	>();
	/** Every dispatch id stop() was called with, in order. */
	readonly stopped: string[] = [];

	constructor(options: { model?: string } = {}) {
		this.model = options.model ?? FAKE_HARNESS_MODEL;
	}

	/** The script the dispatch's session plays once it starts. */
	script(dispatchId: string, script: FakeScript): void {
		this.scripts.set(dispatchId, script);
	}

	/** The token a session was started with, for tests that call as the agent. */
	tokenFor(dispatchId: string): string | undefined {
		return this.sessions.get(dispatchId)?.session.token;
	}

	/** The room a session was started in. */
	roomFor(dispatchId: string): string | undefined {
		return this.sessions.get(dispatchId)?.session.roomRoot;
	}

	/** Everything a session was started with. */
	sessionFor(dispatchId: string): HarnessSession | undefined {
		return this.sessions.get(dispatchId)?.session;
	}

	/** Forgets every session, as a restart would. */
	restart(): void {
		this.sessions.clear();
	}

	async start(session: HarnessSession): Promise<boolean> {
		if (!this.accepting) return false;
		const s = this.scripts.get(session.dispatchId) ?? IDLE;
		const events: HarnessEvent[] = [
			...(s.trace ?? []).map((step) => ({ kind: "step" as const, step })),
			...s.steps.map((split) => ({
				kind: "usage" as const,
				split: { ...split },
			})),
		];
		if (s.outcome !== "until_stopped") events.push({ kind: s.outcome });
		this.sessions.set(session.dispatchId, { session, events });
		return true;
	}

	async has(dispatchId: string): Promise<boolean> {
		return this.sessions.has(dispatchId);
	}

	async next(dispatchId: string): Promise<HarnessEvent | null> {
		return this.sessions.get(dispatchId)?.events.shift() ?? null;
	}

	async stop(dispatchId: string): Promise<void> {
		this.stopped.push(dispatchId);
		this.sessions.delete(dispatchId);
	}
}
