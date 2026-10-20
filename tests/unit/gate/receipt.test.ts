import { describe, expect, it } from "vitest";
import {
	DECIDE_VERSION,
	decide,
	type GateFinding,
} from "../../../src/lib/gate";
import type { GateConfig } from "../../../src/lib/gate/config";
import {
	buildReceipt,
	RECEIPT_VERSION,
	type ReceiptInput,
	type ReceiptOverride,
} from "../../../src/lib/gate/receipt";
import { sha256Hex } from "../../../src/lib/tokens";
import {
	check,
	config,
	finding,
	OLD_SHA,
	override,
	randomScenario,
	rng,
	type Scenario,
	SHA,
} from "./fixtures";

const policy = [
	{ gate: "qa", policy: "mandatory" },
	{ gate: "acceptance", policy: "mandatory" },
] as const;

const BASE = "c".repeat(40);

/** A whole gate config, small enough to read. */
function gateConfig(over: Partial<GateConfig> = {}): GateConfig {
	return {
		version: 1,
		availableSources: config.availableSources,
		testGlobs: ["tests/**"],
		protectedPaths: [".github/workflows/**", "**/vitest.config.*"],
		judgeCoverageGate: "qa",
		...over,
	};
}

function input(
	findings: GateFinding[],
	overrides: ReceiptOverride[] = [],
	over: Partial<ReceiptInput> = {},
): ReceiptInput {
	return {
		missionId: "m1",
		commitSha: SHA,
		baseSha: BASE,
		decision: decide(findings, policy, overrides, config),
		config: gateConfig(),
		findings,
		overrides,
		judges: [
			{
				dispatchId: "dj1",
				agentVersionSha256: "1".repeat(64),
				skillsSha256: "2".repeat(64),
				model: "claude-sonnet-5-5",
				status: "complete",
			},
		],
		dispatches: [
			{
				id: "d1",
				briefSha256: "3".repeat(64),
				harnessVersion: "claude-agent-sdk@1.0.0",
				priceVersion: "2026-10-13",
				spendUsd: 1.25,
			},
		],
		...over,
	};
}

const op = (o: ReturnType<typeof override>, operatorId = "op-1") => ({
	...o,
	operatorId,
});

const parse = (r: { json: string }) => JSON.parse(r.json);

const passing: GateFinding[] = [
	check("t1", "qa", "pass"),
	check("t2", "acceptance", "pass", { source: "file_exists" }),
];

describe("buildReceipt", () => {
	it("is canonical JSON with its own SHA-256 and both versions", () => {
		const r = buildReceipt(input(passing));
		expect(r.sha256).toBe(sha256Hex(r.json));
		const body = parse(r);
		expect(body).toMatchObject({
			receiptVersion: RECEIPT_VERSION,
			decideVersion: DECIDE_VERSION,
			missionId: "m1",
			commitSha: SHA,
			baseSha: BASE,
			verdict: "pass",
			overrides: [],
			degraded: [],
		});
		expect(body.judges[0].model).toBe("claude-sonnet-5-5");
		expect(body.dispatches[0]).toMatchObject({
			priceVersion: "2026-10-13",
			spendUsd: 1.25,
		});
	});

	it("carries an applied override with its rationale and operator", () => {
		const findings = [check("t1", "qa", "fail"), passing[1] as GateFinding];
		const r = buildReceipt(input(findings, [op(override("t1"))]));
		expect(parse(r).verdict).toBe("pass");
		expect(parse(r).overrides).toEqual([
			{
				findingId: "t1",
				commitSha: SHA,
				rationale: "Accepted by the operator",
				operatorId: "op-1",
				applied: true,
				ignoredBecause: null,
			},
		]);
	});

	it("refuses a decision with an override when the input leaves it out", () => {
		const findings = [check("t1", "qa", "fail"), passing[1] as GateFinding];
		const withOverride = input(findings, [op(override("t1"))]);
		expect(() => buildReceipt({ ...withOverride, overrides: [] })).toThrow(
			/does not carry/,
		);
	});

	it("carries an ignored override and why", () => {
		const findings = [check("t1", "qa", "fail"), passing[1] as GateFinding];
		const r = buildReceipt(
			input(findings, [op(override("t1", { commitSha: OLD_SHA }))]),
		);
		expect(parse(r).overrides[0]).toMatchObject({
			applied: false,
			ignoredBecause: "wrong_commit",
		});
	});

	it("refuses an override the decision never saw", () => {
		const base = input(passing);
		expect(() =>
			buildReceipt({ ...base, overrides: [op(override("t1"))] }),
		).toThrow(/never saw/);
	});

	it("refuses a decision for another commit", () => {
		expect(() =>
			buildReceipt({ ...input(passing), commitSha: OLD_SHA }),
		).toThrow(/is for/);
	});

	it("refuses findings that do not match what the decision read", () => {
		const base = input(passing);
		expect(() =>
			buildReceipt({ ...base, findings: passing.slice(0, 1) }),
		).toThrow(/missing/);
		expect(() =>
			buildReceipt({
				...base,
				findings: [...passing, check("t9", "qa", "pass")],
			}),
		).toThrow(/did not read/);
	});

	it("refuses a spend that is not a finite, non-negative number", () => {
		for (const spendUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			const base = input(passing);
			expect(() =>
				buildReceipt({
					...base,
					dispatches: base.dispatches.map((d) => ({ ...d, spendUsd })),
				}),
			).toThrow(/spend/);
		}
	});

	it("lists the degraded not_run findings", () => {
		const findings = [
			...passing,
			check("t3", "acceptance", "not_run", { source: "runner" }),
		];
		expect(parse(buildReceipt(input(findings))).degraded).toEqual([
			{ findingId: "t3", gate: "acceptance", source: "runner" },
		]);
	});

	const configSha = (c: GateConfig) =>
		parse(buildReceipt(input(passing, [], { config: c }))).config.sha256;

	it("hashes the config, whatever the order of its lists", () => {
		const a = gateConfig({ testGlobs: ["tests/**", "**/*.test.ts"] });
		const b: GateConfig = {
			...a,
			availableSources: [...a.availableSources].reverse(),
			testGlobs: [...a.testGlobs].reverse(),
			protectedPaths: [...a.protectedPaths].reverse(),
		};
		expect(configSha(b)).toBe(configSha(a));
	});

	it("changes the config hash when any field changes", () => {
		const a = configSha(gateConfig());
		for (const over of [
			{ version: 2 },
			{ availableSources: ["vitest"] },
			{ testGlobs: ["test/**"] },
			{ protectedPaths: [".github/workflows/**"] },
			{ judgeCoverageGate: "acceptance" as const },
		]) {
			expect(configSha(gateConfig(over)), JSON.stringify(over)).not.toBe(a);
		}
	});

	it("carries the whole config", () => {
		const body = parse(buildReceipt(input(passing)));
		expect(body.config).toMatchObject({
			version: 1,
			judgeCoverageGate: "qa",
			protectedPaths: ["**/vitest.config.*", ".github/workflows/**"],
			testGlobs: ["tests/**"],
		});
	});

	describe("deterministicFindings", () => {
		const judge = finding("judge", {
			id: "j1",
			gate: "qa",
			status: "dismissed",
			severity: "low",
			operatorSeverity: null,
		});
		const all = (over: Partial<Record<string, GateFinding>> = {}) =>
			[
				over.cp ??
					finding("checkpoint", { id: "cp", gate: "qa", outcome: "pass" }),
				over.pf ??
					finding("prior_finding", { id: "pf", gate: "qa", outcome: "pass" }),
				over.sc ?? check("sc", "qa", "pass", { source: "spec-check" }),
				over.fe ?? check("fe", "acceptance", "pass", { source: "file_exists" }),
				over.rn ?? check("rn", "acceptance", "not_run", { source: "runner" }),
				over.vt ?? check("vt", "qa", "pass", { source: "vitest" }),
				over.jd ?? judge,
			] as GateFinding[];
		const det = (fs: GateFinding[]) =>
			parse(buildReceipt(input(fs))).deterministicFindings;

		it("names what it covers, and covers only that", () => {
			expect(det(all())).toMatchObject({
				kinds: ["checkpoint", "prior_finding"],
				checkSources: ["file_exists", "spec-check"],
				findingIds: ["cp", "fe", "pf", "sc"],
			});
		});

		it("changes when a covered finding changes", () => {
			const base = det(all()).sha256;
			for (const over of [
				{
					cp: finding("checkpoint", { id: "cp", gate: "qa", outcome: "fail" }),
				},
				{
					pf: finding("prior_finding", {
						id: "pf",
						gate: "qa",
						outcome: "fail",
					}),
				},
				{ sc: check("sc", "qa", "fail", { source: "spec-check" }) },
				{ fe: check("fe", "acceptance", "fail", { source: "file_exists" }) },
			]) {
				expect(det(all(over)).sha256).not.toBe(base);
			}
		});

		it("does not change when an uncovered finding changes", () => {
			const base = det(all()).sha256;
			for (const over of [
				{ rn: check("rn", "acceptance", "pass", { source: "runner" }) },
				{ vt: check("vt", "qa", "fail", { source: "vitest" }) },
				{ jd: { ...judge, status: "confirmed" } as GateFinding },
			]) {
				expect(det(all(over)).sha256).toBe(base);
			}
		});
	});
});

describe("buildReceipt properties", () => {
	const RUNS = 500;

	function scenarioInput(s: Scenario): ReceiptInput {
		const overrides = s.overrides.map((o, i) => op(o, `op-${i % 2}`));
		return {
			missionId: "m1",
			commitSha: SHA,
			baseSha: BASE,
			decision: decide(s.findings, s.policy, overrides, s.config),
			config: gateConfig({ availableSources: s.config.availableSources }),
			findings: s.findings,
			overrides,
			judges: ["dj2", "dj1", "dj3"].map((dispatchId, i) => ({
				dispatchId,
				agentVersionSha256: String(i).repeat(64),
				skillsSha256: null,
				model: "claude-sonnet-5-5",
				status: "complete" as const,
			})),
			dispatches: ["d3", "d1", "d2"].map((id, i) => ({
				id,
				briefSha256: null,
				harnessVersion: null,
				priceVersion: null,
				spendUsd: i * 0.5,
			})),
		};
	}

	it("never leaves out an override the decision applied or ignored", () => {
		let exercised = 0;
		for (let seed = 1; seed <= RUNS; seed++) {
			const inp = scenarioInput(randomScenario(rng(seed)));
			const body = parse(buildReceipt(inp));
			const applied = inp.decision.reasons.flatMap((r) =>
				r.effect === "overridden"
					? r.overrides.map((rationale) => `${r.findingId}|${rationale}`)
					: [],
			);
			if (applied.length > 0) exercised++;
			const carried = body.overrides
				.filter((o: { applied: boolean }) => o.applied)
				.map((o: ReceiptOverride) => `${o.findingId}|${o.rationale}`);
			for (const a of applied) expect(carried, `seed ${seed}`).toContain(a);
			expect(body.overrides.length, `seed ${seed}`).toBe(inp.overrides.length);
			expect(
				body.overrides.filter((o: { applied: boolean }) => !o.applied).length,
				`seed ${seed}`,
			).toBe(inp.decision.ignoredOverrides.length);
		}
		expect(exercised).toBeGreaterThan(20);
	});

	it("orders two findings that share an id the same way either way round", () => {
		const a = check("dup", "qa", "pass");
		const b = check("dup", "qa", "fail");
		const at = (fs: GateFinding[]) => buildReceipt(input(fs));
		expect(at([a, b])).toEqual(at([b, a]));
	});

	it("is the same receipt whatever the input order", () => {
		for (let seed = 1; seed <= RUNS; seed++) {
			const r = rng(seed + 5_000_000);
			const inp = scenarioInput(randomScenario(rng(seed)));
			const shuffled: ReceiptInput = {
				...inp,
				findings: r.shuffle(inp.findings),
				overrides: r.shuffle(inp.overrides),
				judges: r.shuffle(inp.judges),
				dispatches: r.shuffle(inp.dispatches),
				config: {
					...inp.config,
					availableSources: r.shuffle(inp.config.availableSources),
					protectedPaths: r.shuffle(inp.config.protectedPaths),
				},
			};
			expect(buildReceipt(shuffled), `seed ${seed}`).toEqual(buildReceipt(inp));
		}
	});
});
