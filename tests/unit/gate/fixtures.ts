import {
	GATES,
	type Gate,
	type PlaybookGate,
} from "../../../src/contract/playbook";
import type {
	DecideConfig,
	GateFinding,
	GateOutcome,
	GateOverride,
} from "../../../src/lib/gate";

export const SHA = "a".repeat(40);
export const OLD_SHA = "b".repeat(40);

export const config: DecideConfig = {
	commitSha: SHA,
	availableSources: ["vitest", "stryker"],
};

export function check(
	id: string,
	gate: Gate,
	outcome: GateOutcome,
	over: Partial<Omit<GateFinding, "kind">> = {},
): GateFinding {
	return {
		id,
		gate,
		kind: "check",
		outcome,
		source: "vitest",
		commitSha: SHA,
		subject: `check ${id}`,
		...over,
	} as GateFinding;
}

export function finding<K extends GateFinding["kind"]>(
	kind: K,
	fields: Omit<
		Extract<GateFinding, { kind: K }>,
		"kind" | "commitSha" | "source" | "subject"
	> &
		Partial<Pick<GateFinding, "commitSha" | "source" | "subject">>,
): GateFinding {
	return {
		kind,
		commitSha: SHA,
		source: "vitest",
		subject: `${kind} ${fields.id}`,
		...fields,
	} as unknown as GateFinding;
}

export function override(
	findingId: string,
	over: Partial<GateOverride> = {},
): GateOverride {
	return {
		findingId,
		commitSha: SHA,
		rationale: "Accepted by the operator",
		...over,
	};
}

/** A small seeded generator (mulberry32). Same seed, same sequence, on every platform. */
export function rng(seed: number) {
	let s = seed >>> 0;
	const next = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (n: number) => Math.floor(next() * n);
	const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
	const shuffle = <T>(xs: readonly T[]): T[] => {
		const out = [...xs];
		for (let i = out.length - 1; i > 0; i--) {
			const j = int(i + 1);
			[out[i], out[j]] = [out[j] as T, out[i] as T];
		}
		return out;
	};
	return { next, int, pick, shuffle };
}

export type Rng = ReturnType<typeof rng>;

const SOURCES = ["vitest", "stryker", "axe", "fuzz"] as const;
const OUTCOMES: readonly GateOutcome[] = ["pass", "fail", "error", "not_run"];

export function randomFinding(r: Rng, id: string): GateFinding {
	const base = {
		id,
		gate: r.pick(GATES),
		source: r.pick(SOURCES),
		commitSha: r.next() < 0.85 ? SHA : OLD_SHA,
		subject: `subject ${id}`,
	};
	switch (r.int(5)) {
		case 0:
			return { ...base, kind: "checkpoint", outcome: r.pick(OUTCOMES) };
		case 1:
			return { ...base, kind: "prior_finding", outcome: r.pick(OUTCOMES) };
		case 2:
			return {
				...base,
				kind: "judge",
				status: r.pick(["open", "confirmed", "dismissed"] as const),
				severity: r.pick(["critical", "high", "medium", "low"] as const),
				operatorSeverity: r.pick([null, "low", "critical"] as const),
			};
		case 3:
			return r.pick([
				{
					...base,
					kind: "judge_coverage",
					outcome: "pass",
					reportStatus: "complete",
					openFindings: 0,
				},
				{
					...base,
					kind: "judge_coverage",
					outcome: "fail",
					reportStatus: "blocked",
					openFindings: 1,
				},
				{
					...base,
					kind: "judge_coverage",
					outcome: "not_run",
					reportStatus: null,
					openFindings: 0,
				},
			] as const);
		default:
			return { ...base, kind: "check", outcome: r.pick(OUTCOMES) };
	}
}

export type Scenario = {
	findings: GateFinding[];
	policy: PlaybookGate[];
	overrides: GateOverride[];
	config: DecideConfig;
};

export function randomScenario(r: Rng): Scenario {
	const findings = Array.from({ length: r.int(12) }, (_, i) =>
		randomFinding(r, `f${i}`),
	);
	const policy = r
		.shuffle(GATES)
		.slice(0, r.int(GATES.length + 1))
		.map((gate) => ({ gate, policy: r.pick(["mandatory", "warn"] as const) }));
	const ids = [
		...findings.map((f) => f.id),
		...GATES.map((g) => `not_run:${g}`),
		"nobody",
	];
	const overrides = Array.from({ length: r.int(6) }, () =>
		override(r.pick(ids), {
			commitSha: r.next() < 0.8 ? SHA : OLD_SHA,
			rationale: r.pick(["Known flake", "Client accepted", "  "]),
		}),
	);
	const availableSources = SOURCES.filter(() => r.next() < 0.6);
	return {
		findings,
		policy,
		overrides,
		config: { commitSha: SHA, availableSources },
	};
}
