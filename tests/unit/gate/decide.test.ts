import { describe, expect, it } from "vitest";
import type { PlaybookGate } from "../../../src/contract/playbook";
import {
	DECIDE_VERSION,
	decide,
	type GateFinding,
	resultOf,
} from "../../../src/lib/gate";
import { check, config, finding, OLD_SHA, override } from "./fixtures";

const qaMandatory: PlaybookGate[] = [{ gate: "qa", policy: "mandatory" }];
const qaWarn: PlaybookGate[] = [{ gate: "qa", policy: "warn" }];

const run = (
	findings: GateFinding[],
	policy: PlaybookGate[] = qaMandatory,
	overrides = [] as Parameters<typeof decide>[2],
	cfg = config,
) => decide(findings, policy, overrides, cfg);

const notCheckedIds = (d: ReturnType<typeof decide>) =>
	d.notChecked.map((n) => n.findingId);

const rules = (d: ReturnType<typeof decide>) =>
	d.reasons.map((r) => `${r.findingId}:${r.rule}:${r.effect}`);

describe("decide", () => {
	it("stamps the version and the commit", () => {
		const d = run([check("t1", "qa", "pass")]);
		expect(d.version).toBe(DECIDE_VERSION);
		expect(d.commitSha).toBe(config.commitSha);
	});

	it("g. passes a mandatory gate whose checks pass", () => {
		const d = run([check("t1", "qa", "pass")]);
		expect(d.result).toBe("verified");
		expect(d.gates).toEqual([
			expect.objectContaining({
				gate: "qa",
				policy: "mandatory",
				result: "verified",
			}),
		]);
	});

	describe("a. checkpoint", () => {
		const violation = finding("checkpoint", {
			id: "cp1",
			gate: "security",
			outcome: "fail",
		});

		it("a fail blocks, even on a gate the playbook does not list", () => {
			const d = run([check("t1", "qa", "pass"), violation]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toContain("cp1:checkpoint_violation:block");
		});

		it("a fail is not cleared by an override", () => {
			const d = run([check("t1", "qa", "pass"), violation], qaMandatory, [
				override("cp1"),
			]);
			expect(d.result).toBe("fail");
			expect(d.ignoredOverrides).toEqual([
				expect.objectContaining({ findingId: "cp1", why: "not_overridable" }),
			]);
		});

		it("an error or not_run blocks and is not overridable", () => {
			for (const outcome of ["error", "not_run"] as const) {
				const cp = finding("checkpoint", { id: "cp2", gate: "qa", outcome });
				const d = run([check("t1", "qa", "pass"), cp], qaMandatory, [
					override("cp2"),
				]);
				expect(d.result).toBe("fail");
				expect(rules(d)).toContain("cp2:checkpoint_unproven:block");
			}
		});

		it("a pass is ordinary evidence", () => {
			const cp = finding("checkpoint", {
				id: "cp3",
				gate: "qa",
				outcome: "pass",
			});
			expect(run([cp]).result).toBe("verified");
		});
	});

	describe("b. prior finding", () => {
		it("a fail blocks on any gate, warn or unlisted", () => {
			const prior = finding("prior_finding", {
				id: "p1",
				gate: "rollback",
				outcome: "fail",
			});
			expect(run([check("t1", "qa", "pass"), prior]).result).toBe("fail");
			const onWarn = finding("prior_finding", {
				id: "p2",
				gate: "qa",
				outcome: "fail",
			});
			expect(run([onWarn], qaWarn).result).toBe("fail");
		});

		it("a fail can be overridden at this commit", () => {
			const prior = finding("prior_finding", {
				id: "p1",
				gate: "qa",
				outcome: "fail",
			});
			const d = run([prior], qaMandatory, [
				override("p1", { rationale: "Client accepted" }),
			]);
			// Overridden work is never verified, so it never ships (J, 2026-10-21).
			expect(d.result).toBe("pass");
			expect(d.gates[0]?.result).toBe("pass");
			expect(d.reasons[0]?.overrides).toEqual(["Client accepted"]);
		});
	});

	describe("c. judge", () => {
		const judge = (
			status: "open" | "confirmed" | "dismissed",
			gate = "qa" as const,
		) =>
			finding("judge", {
				id: `j-${status}`,
				gate,
				status,
				severity: "low",
				operatorSeverity: null,
			});

		it("an open finding blocks at any severity or re-grade, on any gate", () => {
			const severities = ["critical", "high", "medium", "low"] as const;
			for (const severity of severities) {
				for (const operatorSeverity of [null, ...severities]) {
					const j = finding("judge", {
						id: "j1",
						gate: "acceptance",
						status: "open",
						severity,
						operatorSeverity,
					});
					const d = run([check("t1", "qa", "pass"), j]);
					expect(d.result).toBe("fail");
					expect(rules(d)).toContain("j1:judge_open:block");
				}
			}
		});

		it("a confirmed finding fails a mandatory gate whatever its re-grade", () => {
			const j = finding("judge", {
				id: "j1",
				gate: "qa",
				status: "confirmed",
				severity: "high",
				operatorSeverity: "low",
			});
			expect(run([check("t1", "qa", "pass"), j]).result).toBe("fail");
		});

		it("an open finding is not cleared by an override", () => {
			const d = run([check("t1", "qa", "pass"), judge("open")], qaMandatory, [
				override("j-open"),
			]);
			expect(d.result).toBe("fail");
			expect(d.ignoredOverrides[0]?.why).toBe("not_overridable");
		});

		it("keeps the operator's re-grade apart from the model's severity", () => {
			const j = finding("judge", {
				id: "j1",
				gate: "qa",
				status: "open",
				severity: "critical",
				operatorSeverity: "low",
			});
			const d = run([check("t1", "qa", "pass"), j]);
			expect(d.reasons.find((r) => r.findingId === "j1")?.severity).toEqual({
				model: "critical",
				operator: "low",
			});
		});

		it("a confirmed finding blocks on any gate; a dismissed one is a pass", () => {
			expect(run([check("t1", "qa", "pass"), judge("confirmed")]).result).toBe(
				"fail",
			);
			expect(
				run([check("t1", "qa", "pass"), judge("confirmed")], qaWarn).result,
			).toBe("fail");
			const unlisted = finding("judge", {
				id: "j-unlisted",
				gate: "security",
				status: "confirmed",
				severity: "low",
				operatorSeverity: null,
			});
			const d = run([check("t1", "qa", "pass"), unlisted]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toContain("j-unlisted:judge_confirmed:block");
			expect(run([check("t1", "qa", "pass"), judge("dismissed")]).result).toBe(
				"verified",
			);
		});

		it("a confirmed finding can be overridden at this commit", () => {
			const d = run(
				[check("t1", "qa", "pass"), judge("confirmed")],
				qaMandatory,
				[override("j-confirmed")],
			);
			expect(d.result).toBe("pass");
			expect(rules(d)).toContain("j-confirmed:judge_confirmed:overridden");
		});

		it("a judge finding is not evidence that the gate ran", () => {
			const d = run([judge("dismissed")]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toContain("not_run:qa:mandatory_not_run:block");
		});
	});

	describe("d. fail or error on a mandatory gate", () => {
		it("blocks on mandatory and warns on warn", () => {
			for (const outcome of ["fail", "error"] as const) {
				expect(run([check("t1", "qa", outcome)]).result).toBe("fail");
				const warned = run([check("t1", "qa", outcome)], qaWarn);
				expect(warned.result).toBe("pass");
				expect(warned.gates[0]?.result).toBe("pass");
			}
		});

		it("one fail among passes blocks", () => {
			const d = run([check("t1", "qa", "pass"), check("t2", "qa", "fail")]);
			expect(d.result).toBe("fail");
		});

		it("an override at this commit clears it; at another commit it does not", () => {
			expect(
				run([check("t1", "qa", "fail")], qaMandatory, [override("t1")]).result,
			).toBe("pass");
			const d = run([check("t1", "qa", "fail")], qaMandatory, [
				override("t1", { commitSha: OLD_SHA }),
			]);
			expect(d.result).toBe("fail");
			expect(d.ignoredOverrides[0]?.why).toBe("wrong_commit");
		});

		it("an override with no written rationale is ignored", () => {
			const d = run([check("t1", "qa", "fail")], qaMandatory, [
				override("t1", { rationale: " \n " }),
			]);
			expect(d.result).toBe("fail");
			expect(d.ignoredOverrides[0]?.why).toBe("no_rationale");
		});

		it("an override for a finding that does not block is ignored", () => {
			const d = run([check("t1", "qa", "pass")], qaMandatory, [override("t1")]);
			expect(d.ignoredOverrides[0]?.why).toBe("no_such_blocker");
		});
	});

	describe("e. not_run on a mandatory gate", () => {
		it("blocks when the source is installed", () => {
			const d = run([check("t1", "qa", "not_run", { source: "stryker" })]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toEqual(["t1:mandatory_not_run:block"]);
		});

		it("warns, tagged degraded, when the source is not installed", () => {
			const d = run([check("t1", "qa", "not_run", { source: "axe" })]);
			expect(d.result).toBe("pass");
			expect(d.gates[0]?.result).toBe("pass");
			expect(d.reasons[0]).toMatchObject({
				rule: "degraded_not_run",
				degraded: true,
			});
		});

		it("warns on a warn gate", () => {
			expect(run([check("t1", "qa", "not_run")], qaWarn).gates[0]?.result).toBe(
				"pass",
			);
		});
	});

	describe("leak a: a listed gate with no findings", () => {
		it("blocks when mandatory, and no override clears it", () => {
			const d = run([], qaMandatory, [override("not_run:qa")]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toEqual(["not_run:qa:mandatory_not_run:block"]);
			expect(d.ignoredOverrides[0]?.why).toBe("not_overridable");
		});

		it("warns when warn", () => {
			expect(run([], qaWarn).gates[0]?.result).toBe("pass");
		});

		it("counts evidence from another commit as none", () => {
			const d = run([check("t1", "qa", "pass", { commitSha: OLD_SHA })]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toEqual([
				"t1:stale_commit:ignored",
				"not_run:qa:mandatory_not_run:block",
			]);
		});
	});

	describe("f. the brief's own checks count on an unlisted gate (version 4)", () => {
		it("counts a file_exists fail as mandatory when acceptance is not listed", () => {
			const brief = check("ck", "acceptance", "fail", {
				source: "file_exists",
			});
			const d = run([check("t1", "qa", "pass"), brief]);
			expect(d.result).toBe("fail");
			expect(rules(d)).toContain("ck:mandatory_failed:block");
		});

		it("keeps a runner check that did not run from verified", () => {
			const brief = check("ck", "acceptance", "not_run", { source: "runner" });
			const d = run([check("t1", "qa", "pass"), brief]);
			expect(d.result).toBe("pass");
			expect(notCheckedIds(d)).toEqual(["ck"]);
		});

		it("still ignores another source's finding on an unlisted gate", () => {
			const other = check("x", "acceptance", "fail", { source: "spec-check" });
			expect(rules(run([check("t1", "qa", "pass"), other]))).toContain(
				"x:unlisted_gate:ignored",
			);
		});

		it("shows the unlisted gate in gates, as mandatory, so a fail has a gate that explains it", () => {
			const brief = check("ck", "acceptance", "fail", {
				source: "file_exists",
			});
			const d = run([check("t1", "qa", "pass"), brief]);
			expect(d.gates.map((g) => [g.gate, g.policy, g.result])).toEqual([
				["qa", "mandatory", "verified"],
				["acceptance", "mandatory", "fail"],
			]);
			// No brief check, no unlisted gate.
			expect(run([check("t1", "qa", "pass")]).gates.map((g) => g.gate)).toEqual(
				["qa"],
			);
		});

		it("counts a brief-check source only on the brief's own gate", () => {
			const elsewhere = check("r", "security", "not_run", { source: "runner" });
			const d = run([check("t1", "qa", "pass"), elsewhere]);
			expect(rules(d)).toContain("r:unlisted_gate:ignored");
			expect(d.result).toBe("verified");
			expect(d.gates.map((g) => g.gate)).toEqual(["qa"]);
		});
	});

	describe("f. unlisted gate", () => {
		it("ignores a fail on a gate the playbook does not list", () => {
			const d = run([
				check("t1", "qa", "pass"),
				check("t2", "security", "fail"),
			]);
			// An ignored reason is not counted, so qa's pass is verified.
			expect(d.result).toBe("verified");
			expect(d.gates.map((g) => g.gate)).toEqual(["qa"]);
			expect(rules(d)).toContain("t2:unlisted_gate:ignored");
		});
	});

	describe("judge coverage", () => {
		it("passes only when complete with no open findings", () => {
			const ok = finding("judge_coverage", {
				id: "jc1",
				gate: "qa",
				outcome: "pass",
				reportStatus: "complete",
				openFindings: 0,
			});
			expect(run([ok]).result).toBe("verified");
			const notRun = finding("judge_coverage", {
				id: "jc2",
				gate: "qa",
				outcome: "not_run",
				reportStatus: null,
				openFindings: 0,
			});
			expect(run([notRun]).result).toBe("fail");
		});

		it("holds a pass that its own fields contradict to not_run", () => {
			const lying = {
				id: "jc3",
				gate: "qa",
				kind: "judge_coverage",
				outcome: "pass",
				reportStatus: "halted",
				openFindings: 0,
				source: "vitest",
				commitSha: config.commitSha,
				subject: "judge",
			} as unknown as GateFinding;
			expect(rules(run([lying]))).toEqual(["jc3:mandatory_not_run:block"]);
		});
	});

	it("takes the stricter policy when a gate is listed twice", () => {
		const twice: PlaybookGate[] = [
			{ gate: "qa", policy: "warn" },
			{ gate: "qa", policy: "mandatory" },
		];
		expect(run([check("t1", "qa", "fail")], twice).result).toBe("fail");
		expect(run([check("t1", "qa", "fail")], [...twice].reverse()).result).toBe(
			"fail",
		);
	});

	it("lists gates in GATES order whatever the playbook order", () => {
		const d = run(
			[],
			[
				{ gate: "acceptance", policy: "warn" },
				{ gate: "phase1-close", policy: "warn" },
				{ gate: "qa", policy: "warn" },
			],
		);
		expect(d.gates.map((g) => g.gate)).toEqual([
			"phase1-close",
			"qa",
			"acceptance",
		]);
	});

	it("does not touch its inputs", () => {
		const findings = [check("t1", "qa", "fail")];
		const overrides = [override("t1")];
		const before = JSON.stringify([findings, overrides]);
		run(findings, qaMandatory, overrides);
		expect(JSON.stringify([findings, overrides])).toBe(before);
	});

	describe("result: verified, pass or fail (J, 2026-10-21)", () => {
		const notChecked = (d: ReturnType<typeof decide>) =>
			d.notChecked.map((n) => `${n.findingId}:${n.kind}:${n.outcome}`);

		it("is verified only when every counted reason passed", () => {
			const both = [
				...qaMandatory,
				{ gate: "acceptance", policy: "warn" },
			] as PlaybookGate[];
			const d = run(
				[check("t1", "qa", "pass"), check("t2", "acceptance", "pass")],
				both,
			);
			expect(d.result).toBe("verified");
			expect(d.gates.map((g) => g.result)).toEqual(["verified", "verified"]);
			// A fail on a warn gate ran, so nothing is unchecked, but it is not
			// verified: it is a pass, which does not ship.
			const warned = run(
				[check("t1", "qa", "pass"), check("t2", "acceptance", "fail")],
				both,
			);
			expect(warned.result).toBe("pass");
			expect(warned.gates.map((g) => g.result)).toEqual(["verified", "pass"]);
			expect(warned.notChecked).toEqual([]);
		});

		it("is not fully checked when a degraded check passes the run having run nothing", () => {
			const d = run([
				check("t1", "qa", "pass", { source: "file_exists" }),
				check("t2", "qa", "not_run", { source: "runner" }),
			]);
			expect(d.result).toBe("pass");
			expect(d.notChecked).toEqual([
				{
					findingId: "t2",
					gate: "qa",
					kind: "check",
					source: "runner",
					outcome: "not_run",
				},
			]);
		});

		it("is not fully checked for a not_run or an error on a warn gate", () => {
			for (const outcome of ["not_run", "error"] as const) {
				const d = run([check("t1", "qa", outcome)], qaWarn);
				expect(d.result, outcome).toBe("pass");
				expect(notChecked(d)).toEqual([`t1:check:${outcome}`]);
			}
		});

		it("is not fully checked for a warn gate with no evidence at all", () => {
			const d = run(
				[check("t1", "qa", "pass")],
				[...qaMandatory, { gate: "acceptance", policy: "warn" }],
			);
			expect(d.result).toBe("pass");
			expect(d.notChecked).toEqual([
				{
					findingId: "not_run:acceptance",
					gate: "acceptance",
					kind: "synthesized",
					source: null,
					outcome: "not_run",
				},
			]);
		});

		it("counts an overridden error: the override clears the block, not the gap", () => {
			const d = run([check("t1", "qa", "error")], qaMandatory, [
				override("t1"),
			]);
			expect(d.result).toBe("pass");
			expect(notChecked(d)).toEqual(["t1:check:error"]);
		});

		it("lists the gap on a failed run too: a checkpoint that did not complete", () => {
			const d = run([
				check("t1", "qa", "pass"),
				finding("checkpoint", { id: "cp", gate: "qa", outcome: "error" }),
			]);
			expect(d.result).toBe("fail");
			expect(notChecked(d)).toEqual(["cp:checkpoint:error"]);
		});

		it("counts a judge's coverage that never ran", () => {
			const d = run([
				check("t1", "qa", "pass"),
				finding("judge_coverage", {
					id: "jc",
					gate: "qa",
					outcome: "not_run",
					reportStatus: null,
					openFindings: 0,
				}),
			]);
			expect(notChecked(d)).toEqual(["jc:judge_coverage:not_run"]);
		});

		it("ignores what decide() ignores: another commit, and an unlisted gate", () => {
			const d = run([
				check("t1", "qa", "pass"),
				check("t2", "qa", "not_run", { commitSha: OLD_SHA }),
				check("t3", "security", "error"),
			]);
			expect(d.result).toBe("verified");
		});

		it("lists what was not checked in gate order, then by id, whatever the input order", () => {
			const findings = [
				check("b", "qa", "not_run", { source: "runner" }),
				check("a", "qa", "not_run", { source: "runner" }),
				check("z", "acceptance", "not_run", { source: "runner" }),
			];
			const policy: PlaybookGate[] = [
				...qaMandatory,
				{ gate: "acceptance", policy: "mandatory" },
			];
			const one = run(findings, policy);
			const two = run([...findings].reverse(), policy);
			expect(notChecked(one)).toEqual(notChecked(two));
			// GATES order: qa before acceptance.
			const order = (["qa", "acceptance"] as const).map((g) =>
				one.notChecked.findIndex((n) => n.gate === g),
			);
			expect(order[0]).toBeLessThan(order[1] as number);
			expect(
				notChecked(one).filter((x) => x.startsWith("a:") || x.startsWith("b:")),
			).toEqual(["a:check:not_run", "b:check:not_run"]);
		});
	});

	describe("resultOf", () => {
		it("is pass with no reasons: nothing was checked", () => {
			expect(resultOf([])).toBe("pass");
			expect(resultOf([{ effect: "ignored" }])).toBe("pass");
			expect(run([], []).result).toBe("pass");
		});

		it("is fail on any block, verified only when every counted effect is pass", () => {
			expect(resultOf([{ effect: "pass" }, { effect: "ignored" }])).toBe(
				"verified",
			);
			for (const effect of ["warn", "overridden"] as const) {
				expect(resultOf([{ effect: "pass" }, { effect }]), effect).toBe("pass");
			}
			expect(resultOf([{ effect: "overridden" }, { effect: "block" }])).toBe(
				"fail",
			);
		});

		it("gives a stored run of any version the result decide() gives today", () => {
			for (const d of [
				run([check("t1", "qa", "pass")]),
				run([check("t1", "qa", "not_run", { source: "runner" })]),
				run([check("t1", "qa", "error")], qaWarn),
				run([check("t1", "qa", "fail")], qaMandatory, [override("t1")]),
				run([], qaWarn),
				run([check("t1", "qa", "fail")]),
			]) {
				expect(resultOf(d.reasons), rules(d).join()).toBe(d.result);
				for (const g of d.gates) expect(resultOf(g.reasons)).toBe(g.result);
			}
		});

		it("is never verified while something was not checked", () => {
			for (const d of [
				run([check("t1", "qa", "not_run", { source: "runner" })]),
				run([check("t1", "qa", "not_run")], qaWarn),
				run([check("t1", "qa", "error")], qaMandatory, [override("t1")]),
				run(
					[check("t1", "qa", "pass")],
					[...qaMandatory, { gate: "acceptance", policy: "warn" }],
				),
			]) {
				expect(d.notChecked.length, rules(d).join()).toBeGreaterThan(0);
				expect(d.result, rules(d).join()).not.toBe("verified");
			}
		});
	});
});
