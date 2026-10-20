import { describe, expect, it } from "vitest";
import { decide, type GateFinding } from "../../../src/lib/gate";
import {
	OLD_SHA,
	randomFinding,
	randomScenario,
	rng,
	type Scenario,
	SHA,
} from "./fixtures";

/** Seeded, so a failure names the seed that reproduces it. */
const RUNS = 2000;

const decideScenario = (s: Scenario) =>
	decide(s.findings, s.policy, s.overrides, s.config);

function forAll(property: (s: Scenario, seed: number) => void) {
	for (let seed = 1; seed <= RUNS; seed++) {
		property(randomScenario(rng(seed)), seed);
	}
}

describe("decide properties", () => {
	it("a. removing every finding for a mandatory gate never turns block into pass", () => {
		let exercised = 0;
		forAll((s, seed) => {
			for (const p of s.policy) {
				if (p.policy !== "mandatory") continue;
				const before = decideScenario(s);
				const after = decideScenario({
					...s,
					findings: s.findings.filter((f) => f.gate !== p.gate),
				});
				if (before.verdict === "block") exercised++;
				expect(after.verdict, `seed ${seed}, gate ${p.gate}`).toBe("block");
			}
		});
		expect(exercised).toBeGreaterThan(100);
	});

	it("b. adding a fail never turns block into pass", () => {
		let exercised = 0;
		forAll((s, seed) => {
			const before = decideScenario(s);
			if (before.verdict !== "block") return;
			exercised++;
			const r = rng(seed + 1_000_000);
			let added = randomFinding(r, "added");
			if ("outcome" in added)
				added = { ...added, outcome: "fail" } as GateFinding;
			else added = { ...added, status: "confirmed" };
			const after = decideScenario({
				...s,
				findings: [
					...s.findings,
					{ ...added, commitSha: r.next() < 0.8 ? SHA : OLD_SHA },
				],
			});
			expect(after.verdict, `seed ${seed}`).toBe("block");
		});
		expect(exercised).toBeGreaterThan(500);
	});

	it("c. shuffling the input order never changes the output", () => {
		forAll((s, seed) => {
			const r = rng(seed + 2_000_000);
			const before = decideScenario(s);
			const after = decideScenario({
				findings: r.shuffle(s.findings),
				policy: r.shuffle(s.policy),
				overrides: r.shuffle(s.overrides),
				config: {
					...s.config,
					availableSources: r.shuffle(s.config.availableSources),
				},
			});
			expect(after, `seed ${seed}`).toEqual(before);
		});
	});

	it("d. an override never clears a checkpoint", () => {
		let exercised = 0;
		forAll((s, seed) => {
			const checkpoints = s.findings.filter(
				(f) =>
					f.kind === "checkpoint" &&
					f.outcome !== "pass" &&
					f.commitSha === SHA,
			);
			if (checkpoints.length === 0) return;
			exercised++;
			const d = decideScenario({
				...s,
				overrides: [
					...s.overrides,
					...checkpoints.map((f) => ({
						findingId: f.id,
						commitSha: SHA,
						rationale: "Ship it anyway",
					})),
				],
			});
			expect(d.verdict, `seed ${seed}`).toBe("block");
			for (const f of checkpoints) {
				const reason = d.reasons.find(
					(x) => x.findingId === f.id && x.kind === "checkpoint",
				);
				expect(reason?.effect, `seed ${seed}, ${f.id}`).toBe("block");
			}
		});
		expect(exercised).toBeGreaterThan(100);
	});

	it("e. confirming an open judge finding never turns block into pass unless an override names it", () => {
		let exercised = 0;
		forAll((s, seed) => {
			const open = s.findings.filter(
				(f) => f.kind === "judge" && f.status === "open" && f.commitSha === SHA,
			);
			for (const target of open) {
				if (s.overrides.some((o) => o.findingId === target.id)) continue;
				exercised++;
				const after = decideScenario({
					...s,
					findings: s.findings.map((f) =>
						f === target ? { ...f, status: "confirmed" as const } : f,
					),
				});
				expect(after.verdict, `seed ${seed}, ${target.id}`).toBe("block");
			}
		});
		expect(exercised).toBeGreaterThan(100);
	});

	it("f. overridable says exactly whether an override at this commit clears the reason", () => {
		let cleared = 0;
		let refused = 0;
		forAll((s, seed) => {
			const before = decideScenario(s);
			for (const r of before.reasons) {
				expect(typeof r.overridable, `seed ${seed}`).toBe("boolean");
				if (r.effect !== "block" && r.effect !== "overridden") {
					expect(
						r.overridable,
						`seed ${seed}, ${r.findingId} ${r.effect}`,
					).toBe(false);
					continue;
				}
				const rationale = "Property override";
				const after = decideScenario({
					...s,
					overrides: [
						...s.overrides,
						{ findingId: r.findingId, commitSha: SHA, rationale },
					],
				});
				const same = after.reasons.find(
					(x) =>
						x.findingId === r.findingId &&
						x.kind === r.kind &&
						x.rule === r.rule &&
						x.subject === r.subject,
				);
				if (r.overridable) {
					cleared++;
					expect(same?.effect, `seed ${seed}, ${r.findingId}`).toBe(
						"overridden",
					);
					expect(same?.overridable, `seed ${seed}, ${r.findingId}`).toBe(true);
				} else {
					refused++;
					expect(same?.effect, `seed ${seed}, ${r.findingId}`).toBe("block");
					expect(
						after.ignoredOverrides.some(
							(o) =>
								o.findingId === r.findingId &&
								o.rationale === rationale &&
								o.why === "not_overridable",
						),
						`seed ${seed}, ${r.findingId}`,
					).toBe(true);
				}
			}
		});
		expect(cleared).toBeGreaterThan(200);
		expect(refused).toBeGreaterThan(200);
	});

	it("is the same on a second call with the same inputs", () => {
		forAll((s, seed) => {
			expect(decideScenario(s), `seed ${seed}`).toEqual(decideScenario(s));
		});
	});
});
