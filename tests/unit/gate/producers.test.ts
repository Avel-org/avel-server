import { describe, expect, it } from "vitest";
import type { Brief, BriefCheck } from "../../../src/contract";
import { decide } from "../../../src/lib/gate";
import {
	briefCheckFindings,
	type JudgeRun,
	judgeCoverageFindings,
	specCheckFindings,
	testGlobFindings,
} from "../../../src/lib/gate/producers";
import type { FileChange } from "../../../src/rooms/checkpoint";
import { matchesGlob, supportedGlob } from "../../../src/rooms/globs";
import { config, override, rng, SHA } from "./fixtures";

const outcomes = (fs: ReturnType<typeof specCheckFindings>) =>
	fs.map((f) => `${f.id}:${"outcome" in f ? f.outcome : f.kind}`);

/** A brief that passes: two requirements, each with a criterion and a check. */
function brief(over: Partial<Brief> = {}): Brief {
	return {
		summary: "Online booking for a salon",
		requirements: [
			{ id: "R1", text: "A client books a slot" },
			{ id: "R2", text: "A stylist sees the day's bookings" },
		],
		acceptanceCriteria: [
			{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
			{ id: "AC2", requirementId: "R2", text: "The day view lists bookings" },
		],
		modules: [
			{ id: "M1", name: "Booking", requirementIds: ["R1"], reads: [] },
			{ id: "M2", name: "Schedule", requirementIds: ["R2"], reads: [] },
		],
		checks: [
			{ id: "CK1", requirementId: "R1", kind: "test", command: "pnpm test R1" },
			{
				id: "CK2",
				requirementId: "R2",
				kind: "file_exists",
				path: "src/day.ts",
			},
		],
		...over,
	};
}

describe("specCheckFindings", () => {
	it("passes every requirement of a complete brief, on the alignment gate", () => {
		const fs = specCheckFindings(brief(), SHA);
		expect(outcomes(fs)).toEqual(["spec-check:R1:pass", "spec-check:R2:pass"]);
		expect(fs.every((f) => f.gate === "alignment" && f.commitSha === SHA)).toBe(
			true,
		);
		const d = decide(
			fs,
			[{ gate: "alignment", policy: "mandatory" }],
			[],
			config,
		);
		expect(d.verdict).toBe("pass");
	});

	it("fails a requirement with no acceptance criterion", () => {
		const fs = specCheckFindings(
			brief({ acceptanceCriteria: [brief().acceptanceCriteria[0] as never] }),
			SHA,
		);
		expect(outcomes(fs)).toEqual(["spec-check:R1:pass", "spec-check:R2:fail"]);
		expect(fs[1]?.subject).toContain("no acceptance criterion");
	});

	it("fails a requirement with no check", () => {
		const fs = specCheckFindings(
			brief({ checks: [brief().checks[0] as BriefCheck] }),
			SHA,
		);
		expect(outcomes(fs)).toEqual(["spec-check:R1:pass", "spec-check:R2:fail"]);
		expect(fs[1]?.subject).toContain("no check outside the agent");
	});

	it("fails a check that cites no requirement, and one that reuses an id", () => {
		const fs = specCheckFindings(
			brief({
				checks: [
					...brief().checks,
					{ id: "CK3", requirementId: "R9", kind: "command", command: "x" },
					{ id: "CK1", requirementId: "R1", kind: "command", command: "y" },
				],
			}),
			SHA,
		);
		expect(outcomes(fs)).toEqual([
			"spec-check:CK1:3:fail",
			"spec-check:CK3:2:fail",
			"spec-check:R1:pass",
			"spec-check:R2:pass",
		]);
	});

	it("fails a brief with no requirements", () => {
		const fs = specCheckFindings(
			brief({ requirements: [], acceptanceCriteria: [], checks: [] }),
			SHA,
		);
		expect(outcomes(fs)).toEqual(["spec-check:requirements:fail"]);
	});

	it("is an error when the brief does not parse", () => {
		expect(outcomes(specCheckFindings({ summary: 3 }, SHA))).toEqual([
			"spec-check:brief:error",
		]);
		expect(outcomes(specCheckFindings(null, SHA))).toEqual([
			"spec-check:brief:error",
		]);
	});
});

describe("testGlobFindings", () => {
	const testGlobs = ["tests/**", "**/*.test.ts"];
	/** A bare path is an added file. */
	const run = (
		roles: Parameters<typeof testGlobFindings>[0]["roles"],
		changes: Array<string | FileChange>,
		globs = testGlobs,
	) =>
		testGlobFindings({
			dispatchId: "d1",
			roles,
			changes: changes.map((c) =>
				typeof c === "string" ? { kind: "added", path: c } : c,
			),
			testGlobs: globs,
			commitSha: SHA,
		});

	it("fails an author deleting a test file", () => {
		expect(
			outcomes(run(["domain"], [{ kind: "deleted", path: "tests/x.test.ts" }])),
		).toEqual(["checkpoint:test-glob:d1:tests/x.test.ts:fail"]);
	});

	it("fails an author renaming a test file into src/", () => {
		const fs = run(
			["domain"],
			[{ kind: "renamed", from: "tests/x.test.ts", path: "src/x.ts" }],
		);
		expect(outcomes(fs)).toEqual([
			"checkpoint:test-glob:d1:src/x.ts:pass",
			"checkpoint:test-glob:d1:tests/x.test.ts:fail",
		]);
		expect(fs[1]?.subject).toContain("renamed");
	});

	it("fails a tester renaming source into the tests", () => {
		expect(
			outcomes(
				run(
					["backend-tests"],
					[{ kind: "renamed", from: "src/a.ts", path: "tests/a.ts" }],
				),
			),
		).toEqual([
			"checkpoint:test-glob:d1:src/a.ts:fail",
			"checkpoint:test-glob:d1:tests/a.ts:pass",
		]);
	});

	it("fails a tester deleting source", () => {
		expect(
			outcomes(run(["backend-tests"], [{ kind: "deleted", path: "src/a.ts" }])),
		).toEqual(["checkpoint:test-glob:d1:src/a.ts:fail"]);
	});

	it("fails an author's write under a test glob and passes one outside", () => {
		const fs = run(["domain"], ["src/a.ts", "src/a.test.ts", "tests/b.ts"]);
		expect(outcomes(fs)).toEqual([
			"checkpoint:test-glob:d1:src/a.test.ts:fail",
			"checkpoint:test-glob:d1:src/a.ts:pass",
			"checkpoint:test-glob:d1:tests/b.ts:fail",
		]);
		expect(
			fs.every(
				(f) => f.kind === "checkpoint" && f.source === "checkpoint:test-glob",
			),
		).toBe(true);
	});

	it("fails a tester's write outside the test globs", () => {
		expect(
			outcomes(run(["backend-tests"], ["tests/a.ts", "src/a.ts"])),
		).toEqual([
			"checkpoint:test-glob:d1:src/a.ts:fail",
			"checkpoint:test-glob:d1:tests/a.ts:pass",
		]);
	});

	it("fails a judge's write under a test glob", () => {
		expect(
			outcomes(
				run(
					["security-review"],
					["findings/security-review/a.md", "tests/x.ts"],
				),
			),
		).toEqual([
			"checkpoint:test-glob:d1:findings/security-review/a.md:pass",
			"checkpoint:test-glob:d1:tests/x.ts:fail",
		]);
	});

	it("fails the fixture's write under a test glob, and passes fixtures/golden/", () => {
		expect(
			outcomes(
				run(["fixture"], ["fixtures/golden/a.json", "tests/golden/a.json"]),
			),
		).toEqual([
			"checkpoint:test-glob:d1:fixtures/golden/a.json:pass",
			"checkpoint:test-glob:d1:tests/golden/a.json:fail",
		]);
	});

	it("finds nothing for roles with no side", () => {
		expect(run(["accessibility"], ["tests/a.ts"])).toEqual([]);
	});

	it("passes a dispatch that wrote nothing", () => {
		expect(outcomes(run(["domain"], []))).toEqual([
			"checkpoint:test-glob:d1:pass",
		]);
	});

	it("is an error with no roles, mixed sides, no globs, or a glob it cannot read", () => {
		for (const fs of [
			run([], ["src/a.ts"]),
			run(["domain", "backend-tests"], ["src/a.ts"]),
			run(["domain"], ["src/a.ts"], []),
			run(["domain"], ["src/a.spec.ts"], ["**/*.{spec,test}.ts"]),
		]) {
			expect(outcomes(fs)).toEqual(["checkpoint:test-glob:d1:error"]);
		}
	});

	it("blocks the decision, and no override clears it", () => {
		const fs = run(["domain"], ["tests/a.test.ts"]);
		const d = decide(
			fs,
			[{ gate: "qa", policy: "warn" }],
			[override("checkpoint:test-glob:d1:tests/a.test.ts")],
			config,
		);
		expect(d.verdict).toBe("block");
		expect(d.ignoredOverrides[0]?.why).toBe("not_overridable");
	});

	it("does not depend on the order of the written paths", () => {
		const paths = ["src/a.ts", "tests/b.ts", "src/c.test.ts", "src/d.ts"];
		const r = rng(7);
		for (let i = 0; i < 20; i++) {
			expect(run(["domain"], r.shuffle(paths))).toEqual(run(["domain"], paths));
		}
	});
});

describe("briefCheckFindings", () => {
	const tree = { "src/day.ts": "a1", "src/lib/x.ts": "b2" };

	it("passes a file_exists check whose path is in the tree, and fails one that is not", () => {
		const fs = briefCheckFindings(
			[
				{
					id: "CK1",
					requirementId: "R1",
					kind: "file_exists",
					path: "src/day.ts",
				},
				{
					id: "CK2",
					requirementId: "R2",
					kind: "file_exists",
					path: "src/night.ts",
				},
				{
					id: "CK3",
					requirementId: "R3",
					kind: "file_exists",
					path: "src/lib/*.ts",
				},
			],
			tree,
			SHA,
		);
		expect(outcomes(fs)).toEqual([
			"check:CK1:0:pass",
			"check:CK2:1:fail",
			"check:CK3:2:pass",
		]);
		expect(fs.every((f) => f.gate === "acceptance")).toBe(true);
	});

	it("is an error for a path the matcher cannot read", () => {
		const fs = briefCheckFindings(
			[
				{
					id: "CK1",
					requirementId: "R1",
					kind: "file_exists",
					path: "src/{a,b}.ts",
				},
			],
			{ "src/a.ts": "a1" },
			SHA,
		);
		expect(outcomes(fs)).toEqual(["check:CK1:0:error"]);
	});

	it("marks test, typecheck and command not_run from the runner", () => {
		const fs = briefCheckFindings(
			[
				{ id: "CK1", requirementId: "R1", kind: "test", command: "pnpm test" },
				{ id: "CK2", requirementId: "R1", kind: "typecheck", command: "tsc" },
				{ id: "CK3", requirementId: "R1", kind: "command", command: "make" },
			],
			tree,
			SHA,
		);
		expect(outcomes(fs)).toEqual([
			"check:CK1:0:not_run",
			"check:CK2:1:not_run",
			"check:CK3:2:not_run",
		]);
		expect(fs.every((f) => f.source === "runner")).toBe(true);
		const acceptance = [{ gate: "acceptance", policy: "mandatory" } as const];
		const degraded = decide(fs, acceptance, [], config);
		expect(degraded.verdict).toBe("pass");
		expect(degraded.reasons.every((r) => r.degraded)).toBe(true);
		const installed = decide(fs, acceptance, [], {
			...config,
			availableSources: ["runner"],
		});
		expect(installed.verdict).toBe("block");
	});

	it("does not depend on the tree's key order", () => {
		const checks: BriefCheck[] = [
			{
				id: "CK1",
				requirementId: "R1",
				kind: "file_exists",
				path: "src/lib/x.ts",
			},
		];
		const reversed = Object.fromEntries(Object.entries(tree).reverse());
		expect(briefCheckFindings(checks, reversed, SHA)).toEqual(
			briefCheckFindings(checks, tree, SHA),
		);
	});
});

describe("judgeCoverageFindings", () => {
	const judge = (id: string, dispatch: JudgeRun["dispatch"]): JudgeRun => ({
		rosterEntryId: id,
		dispatch,
	});
	const report = (status: "complete" | "blocked" | "failed" | "halted") => ({
		report: { status },
	});

	it("maps each judge to its coverage", () => {
		const fs = judgeCoverageFindings({
			judges: [
				judge("j1", { id: "d1", ...report("complete") }),
				judge("j2", { id: "d2", ...report("complete") }),
				judge("j3", { id: "d3", ...report("halted") }),
				judge("j4", null),
				judge("j5", { id: "d5", report: null }),
				judge("j6", { id: "d6", ...report("blocked") }),
				judge("j7", { id: "d7", ...report("failed") }),
			],
			findings: [
				{ reportedByDispatchId: "d2", status: "open" },
				{ reportedByDispatchId: "d1", status: "confirmed" },
				{ reportedByDispatchId: "d1", status: "dismissed" },
				{ reportedByDispatchId: null, status: "open" },
			],
			gate: "qa",
			commitSha: SHA,
		});
		expect(
			fs.map((f) => [f.id, f.outcome, f.reportStatus, f.openFindings]),
		).toEqual([
			["judge-coverage:j1", "pass", "complete", 0],
			["judge-coverage:j2", "fail", "complete", 1],
			["judge-coverage:j3", "not_run", "halted", 0],
			["judge-coverage:j4", "not_run", null, 0],
			["judge-coverage:j5", "not_run", null, 0],
			["judge-coverage:j6", "fail", "blocked", 0],
			["judge-coverage:j7", "fail", "failed", 0],
		]);
	});

	it("does not depend on the order of the judges or the findings", () => {
		const judges = [
			judge("j3", null),
			judge("j1", { id: "d1", ...report("complete") }),
			judge("j2", { id: "d2", ...report("blocked") }),
		];
		const findings = [
			{ reportedByDispatchId: "d1", status: "open" as const },
			{ reportedByDispatchId: "d2", status: "confirmed" as const },
		];
		const at = (js: JudgeRun[], fs: typeof findings) =>
			judgeCoverageFindings({
				judges: js,
				findings: fs,
				gate: "qa",
				commitSha: SHA,
			});
		const expected = at(judges, findings);
		expect(expected.map((f) => f.id)).toEqual([
			"judge-coverage:j1",
			"judge-coverage:j2",
			"judge-coverage:j3",
		]);
		const r = rng(11);
		for (let i = 0; i < 20; i++) {
			expect(at(r.shuffle(judges), r.shuffle(findings))).toEqual(expected);
		}
	});

	it("blocks a mandatory gate when a judge never ran", () => {
		const fs = judgeCoverageFindings({
			judges: [judge("j1", null)],
			findings: [],
			gate: "qa",
			commitSha: SHA,
		});
		const d = decide(fs, [{ gate: "qa", policy: "mandatory" }], [], {
			...config,
			availableSources: ["judge"],
		});
		expect(d.verdict).toBe("block");
	});
});

describe("supportedGlob", () => {
	it("is false only for globs that matchesGlob never matches", () => {
		const unsupported = ["", "/abs", "src/{a,b}.ts", "[ab].ts", "!x", "a\\b"];
		for (const g of unsupported) {
			expect(supportedGlob(g)).toBe(false);
			expect(matchesGlob(g, g)).toBe(false);
		}
		for (const g of ["src/**", "*.ts", "a/?.ts", "./x.ts", "dir/"]) {
			expect(supportedGlob(g)).toBe(true);
		}
	});
});
