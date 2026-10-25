import { describe, expect, it } from "vitest";
import {
	type PriorCheck,
	priorFindingFindings,
} from "../../src/lib/gate/producers";

const COMMIT = "c".repeat(40);

const check = (
	findingId: string,
	text: string,
	paths = ["src/**"],
): PriorCheck => ({
	findingId,
	foundIn: "template-booking sprint 1",
	subject: "A debugger statement shipped",
	check: { kind: "forbidden_text", paths, text, scope: "general" },
});

const run = (
	checks: PriorCheck[],
	changed: { path: string; text: string | null }[],
) => priorFindingFindings({ checks, changed, gate: "qa", commitSha: COMMIT });

const outcomes = (fs: ReturnType<typeof run>) =>
	fs.map((f) => [f.id, "outcome" in f ? f.outcome : null]);

describe("priorFindingFindings", () => {
	it("fails when a changed file under the check's paths holds its text, literally", () => {
		const fs = run(
			[check("f1", "debugger")],
			[
				{ path: "src/a.ts", text: "export const a = 1;\n" },
				{ path: "src/b.ts", text: "debugger;\n" },
			],
		);
		expect(outcomes(fs)).toEqual([["prior:f1", "fail"]]);
		// Words only: the finding's id is the finding's own id field (FE, 2026-10-24).
		expect(fs[0]?.subject).toBe(
			'A debugger statement shipped (found in template-booking sprint 1): "debugger" is back in src/b.ts',
		);
		expect(fs[0]?.subject).not.toContain("src/a.ts");
	});

	it("passes when the text is only outside its paths, differs in case, or nothing is under them", () => {
		expect(
			outcomes(
				run(
					[check("f1", "debugger", ["src/features/**"])],
					[{ path: "src/b.ts", text: "debugger;\n" }],
				),
			),
		).toEqual([["prior:f1", "pass"]]);
		expect(
			outcomes(
				run(
					[check("f1", "debugger")],
					[{ path: "src/b.ts", text: "Debugger\n" }],
				),
			),
		).toEqual([["prior:f1", "pass"]]);
		expect(outcomes(run([check("f1", "debugger")], []))).toEqual([
			["prior:f1", "pass"],
		]);
	});

	it("is not run when no file holds the text but one under its paths was too large to read", () => {
		const fs = run(
			[check("f1", "debugger")],
			[
				{ path: "src/a.ts", text: "fine\n" },
				{ path: "src/huge.ts", text: null },
			],
		);
		expect(outcomes(fs)).toEqual([["prior:f1", "not_run"]]);
		expect(fs[0]?.subject).toContain("src/huge.ts");
		// A hit elsewhere still fails, whatever could not be read.
		expect(
			outcomes(
				run(
					[check("f1", "debugger")],
					[
						{ path: "src/huge.ts", text: null },
						{ path: "src/b.ts", text: "debugger" },
					],
				),
			),
		).toEqual([["prior:f1", "fail"]]);
	});

	it("gives one finding per check, in id order, whatever order the checks arrive in", () => {
		const changed = [{ path: "src/b.ts", text: "debugger" }];
		const a = run([check("f2", "x"), check("f1", "debugger")], changed);
		const b = run([check("f1", "debugger"), check("f2", "x")], changed);
		expect(a).toEqual(b);
		expect(outcomes(a)).toEqual([
			["prior:f1", "fail"],
			["prior:f2", "pass"],
		]);
	});
});
