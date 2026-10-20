import { describe, expect, it } from "vitest";
import type { PlaybookGate } from "../../../src/contract/playbook";
import {
	DECIDE_VERSION,
	decide,
	type GateFinding,
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
		expect(d.verdict).toBe("pass");
		expect(d.gates).toEqual([
			expect.objectContaining({
				gate: "qa",
				policy: "mandatory",
				verdict: "pass",
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
			expect(d.verdict).toBe("block");
			expect(rules(d)).toContain("cp1:checkpoint_violation:block");
		});

		it("a fail is not cleared by an override", () => {
			const d = run([check("t1", "qa", "pass"), violation], qaMandatory, [
				override("cp1"),
			]);
			expect(d.verdict).toBe("block");
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
				expect(d.verdict).toBe("block");
				expect(rules(d)).toContain("cp2:checkpoint_unproven:block");
			}
		});

		it("a pass is ordinary evidence", () => {
			const cp = finding("checkpoint", {
				id: "cp3",
				gate: "qa",
				outcome: "pass",
			});
			expect(run([cp]).verdict).toBe("pass");
		});
	});

	describe("b. prior finding", () => {
		it("a fail blocks on any gate, warn or unlisted", () => {
			const prior = finding("prior_finding", {
				id: "p1",
				gate: "rollback",
				outcome: "fail",
			});
			expect(run([check("t1", "qa", "pass"), prior]).verdict).toBe("block");
			const onWarn = finding("prior_finding", {
				id: "p2",
				gate: "qa",
				outcome: "fail",
			});
			expect(run([onWarn], qaWarn).verdict).toBe("block");
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
			expect(d.verdict).toBe("pass");
			expect(d.gates[0]?.verdict).toBe("overridden");
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
					expect(d.verdict).toBe("block");
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
			expect(run([check("t1", "qa", "pass"), j]).verdict).toBe("block");
		});

		it("an open finding is not cleared by an override", () => {
			const d = run([check("t1", "qa", "pass"), judge("open")], qaMandatory, [
				override("j-open"),
			]);
			expect(d.verdict).toBe("block");
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
			expect(run([check("t1", "qa", "pass"), judge("confirmed")]).verdict).toBe(
				"block",
			);
			expect(
				run([check("t1", "qa", "pass"), judge("confirmed")], qaWarn).verdict,
			).toBe("block");
			const unlisted = finding("judge", {
				id: "j-unlisted",
				gate: "security",
				status: "confirmed",
				severity: "low",
				operatorSeverity: null,
			});
			const d = run([check("t1", "qa", "pass"), unlisted]);
			expect(d.verdict).toBe("block");
			expect(rules(d)).toContain("j-unlisted:judge_confirmed:block");
			expect(run([check("t1", "qa", "pass"), judge("dismissed")]).verdict).toBe(
				"pass",
			);
		});

		it("a confirmed finding can be overridden at this commit", () => {
			const d = run(
				[check("t1", "qa", "pass"), judge("confirmed")],
				qaMandatory,
				[override("j-confirmed")],
			);
			expect(d.verdict).toBe("pass");
			expect(rules(d)).toContain("j-confirmed:judge_confirmed:overridden");
		});

		it("a judge finding is not evidence that the gate ran", () => {
			const d = run([judge("dismissed")]);
			expect(d.verdict).toBe("block");
			expect(rules(d)).toContain("not_run:qa:mandatory_not_run:block");
		});
	});

	describe("d. fail or error on a mandatory gate", () => {
		it("blocks on mandatory and warns on warn", () => {
			for (const outcome of ["fail", "error"] as const) {
				expect(run([check("t1", "qa", outcome)]).verdict).toBe("block");
				const warned = run([check("t1", "qa", outcome)], qaWarn);
				expect(warned.verdict).toBe("pass");
				expect(warned.gates[0]?.verdict).toBe("warn");
			}
		});

		it("one fail among passes blocks", () => {
			const d = run([check("t1", "qa", "pass"), check("t2", "qa", "fail")]);
			expect(d.verdict).toBe("block");
		});

		it("an override at this commit clears it; at another commit it does not", () => {
			expect(
				run([check("t1", "qa", "fail")], qaMandatory, [override("t1")]).verdict,
			).toBe("pass");
			const d = run([check("t1", "qa", "fail")], qaMandatory, [
				override("t1", { commitSha: OLD_SHA }),
			]);
			expect(d.verdict).toBe("block");
			expect(d.ignoredOverrides[0]?.why).toBe("wrong_commit");
		});

		it("an override with no written rationale is ignored", () => {
			const d = run([check("t1", "qa", "fail")], qaMandatory, [
				override("t1", { rationale: " \n " }),
			]);
			expect(d.verdict).toBe("block");
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
			expect(d.verdict).toBe("block");
			expect(rules(d)).toEqual(["t1:mandatory_not_run:block"]);
		});

		it("warns, tagged degraded, when the source is not installed", () => {
			const d = run([check("t1", "qa", "not_run", { source: "axe" })]);
			expect(d.verdict).toBe("pass");
			expect(d.gates[0]?.verdict).toBe("warn");
			expect(d.reasons[0]).toMatchObject({
				rule: "degraded_not_run",
				degraded: true,
			});
		});

		it("warns on a warn gate", () => {
			expect(
				run([check("t1", "qa", "not_run")], qaWarn).gates[0]?.verdict,
			).toBe("warn");
		});
	});

	describe("leak a: a listed gate with no findings", () => {
		it("blocks when mandatory, and no override clears it", () => {
			const d = run([], qaMandatory, [override("not_run:qa")]);
			expect(d.verdict).toBe("block");
			expect(rules(d)).toEqual(["not_run:qa:mandatory_not_run:block"]);
			expect(d.ignoredOverrides[0]?.why).toBe("not_overridable");
		});

		it("warns when warn", () => {
			expect(run([], qaWarn).gates[0]?.verdict).toBe("warn");
		});

		it("counts evidence from another commit as none", () => {
			const d = run([check("t1", "qa", "pass", { commitSha: OLD_SHA })]);
			expect(d.verdict).toBe("block");
			expect(rules(d)).toEqual([
				"t1:stale_commit:ignored",
				"not_run:qa:mandatory_not_run:block",
			]);
		});
	});

	describe("f. unlisted gate", () => {
		it("ignores a fail on a gate the playbook does not list", () => {
			const d = run([
				check("t1", "qa", "pass"),
				check("t2", "security", "fail"),
			]);
			expect(d.verdict).toBe("pass");
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
			expect(run([ok]).verdict).toBe("pass");
			const notRun = finding("judge_coverage", {
				id: "jc2",
				gate: "qa",
				outcome: "not_run",
				reportStatus: null,
				openFindings: 0,
			});
			expect(run([notRun]).verdict).toBe("block");
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
		expect(run([check("t1", "qa", "fail")], twice).verdict).toBe("block");
		expect(run([check("t1", "qa", "fail")], [...twice].reverse()).verdict).toBe(
			"block",
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
});
