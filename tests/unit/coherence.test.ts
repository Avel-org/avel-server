import { describe, expect, it } from "vitest";
import {
	type CoherenceEntry,
	type CoherencePlaybook,
	classifyGlob,
	coherenceResult,
	computeCoherence,
	earliestWave,
	globsOverlap,
	pathSetsOverlap,
	resolveWritablePaths,
} from "../../src/contract";

let n = 0;
function entry(fields: Partial<CoherenceEntry> = {}): CoherenceEntry {
	n += 1;
	return {
		id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
		active: true,
		waves: ["A"],
		kind: "horizontal",
		roles: ["schema"],
		writablePaths: ["src/db/**"],
		...fields,
	};
}

const playbook = (
	wavesApplicable: CoherencePlaybook["wavesApplicable"],
): CoherencePlaybook => ({
	wavesApplicable,
	gates: [{ gate: "qa", policy: "mandatory" }],
});

const foundations = () => entry({ roles: ["foundations"], waves: ["A"] });
const verification = () =>
	entry({
		roles: ["backend-tests"],
		waves: ["C"],
		writablePaths: ["tests/**"],
	});

describe("earliestWave", () => {
	it("takes the lowest wave in A-to-E order, whatever order the playbook lists", () => {
		expect(earliestWave(playbook(["C", "B", "E"]))).toBe("B");
		expect(earliestWave(playbook(["E", "A"]))).toBe("A");
		expect(earliestWave(playbook(["D"]))).toBe("D");
	});

	it("is null when the playbook declares no waves", () => {
		expect(earliestWave(playbook([]))).toBeNull();
	});
});

describe("resolveWritablePaths", () => {
	it("keeps the template's paths when the entry has none, and takes the override otherwise", () => {
		const template = { writablePaths: ["src/**"] };
		expect(resolveWritablePaths({ writablePaths: null }, template)).toEqual([
			"src/**",
		]);
		expect(
			resolveWritablePaths({ writablePaths: ["src/db/**"] }, template),
		).toEqual(["src/db/**"]);
	});
});

describe("computeCoherence: the first-wave block", () => {
	it("passes when an active agent is in the earliest declared wave", () => {
		const result = computeCoherence(
			{ cut: "horizontal", roster: [entry({ waves: ["B"] })] },
			playbook(["C", "B"]),
		);
		expect(result).toEqual({ warnings: [] });
		expect(coherenceResult.parse(result)).toEqual(result);
	});

	it("blocks when only a later wave is staffed, naming the earliest", () => {
		const result = computeCoherence(
			{ cut: "horizontal", roster: [entry({ waves: ["B"] })] },
			playbook(["A", "B"]),
		);
		expect(result.block).toMatchObject({
			code: "no_agents_in_first_wave",
			wave: "A",
		});
		expect(coherenceResult.parse(result)).toEqual(result);
	});

	it("does not count an inactive agent", () => {
		const result = computeCoherence(
			{ cut: "horizontal", roster: [entry({ waves: ["A"], active: false })] },
			playbook(["A"]),
		);
		expect(result.block?.wave).toBe("A");
	});

	it("blocks an empty roster", () => {
		expect(
			computeCoherence({ cut: "horizontal", roster: [] }, playbook(["A"])).block
				?.code,
		).toBe("no_agents_in_first_wave");
	});

	it("fails closed with wave null when the playbook declares no waves", () => {
		const result = computeCoherence(
			{ cut: "horizontal", roster: [entry({ waves: ["A", "B"] })] },
			playbook([]),
		);
		expect(result.block).toMatchObject({
			code: "no_agents_in_first_wave",
			wave: null,
		});
		expect(coherenceResult.parse(result)).toEqual(result);
	});
});

describe("computeCoherence: vertical-cut roles", () => {
	it("warns of nothing when foundations and verification are both active", () => {
		const result = computeCoherence(
			{ cut: "vertical", roster: [foundations(), verification()] },
			playbook(["A"]),
		);
		expect(result).toEqual({ warnings: [] });
	});

	it("names each missing role, foundations first", () => {
		const none = computeCoherence(
			{ cut: "vertical", roster: [entry({ roles: ["domain"] })] },
			playbook(["A"]),
		);
		expect(none.warnings).toEqual([
			{
				code: "vertical_cut_roles_unassigned",
				reason: expect.any(String),
				missing: ["foundations", "verification"],
			},
		]);
		expect(
			computeCoherence(
				{ cut: "vertical", roster: [foundations()] },
				playbook(["A"]),
			).warnings[0]?.missing,
		).toEqual(["verification"]);
		expect(
			computeCoherence(
				{ cut: "vertical", roster: [entry({ waves: ["A"] }), verification()] },
				playbook(["A"]),
			).warnings[0]?.missing,
		).toEqual(["foundations"]);
	});

	it("counts any Verify-family role as verification", () => {
		for (const role of [
			"frontend-tests",
			"property-tests",
			"accessibility",
			"performance",
		] as const) {
			const result = computeCoherence(
				{ cut: "vertical", roster: [foundations(), entry({ roles: [role] })] },
				playbook(["A"]),
			);
			expect(result.warnings).toEqual([]);
		}
	});

	it("does not count a review role as verification", () => {
		const result = computeCoherence(
			{
				cut: "vertical",
				roster: [foundations(), entry({ roles: ["security-review"] })],
			},
			playbook(["A"]),
		);
		expect(result.warnings[0]?.missing).toEqual(["verification"]);
	});

	it("does not count an inactive role holder", () => {
		const result = computeCoherence(
			{
				cut: "vertical",
				roster: [foundations(), { ...verification(), active: false }],
			},
			playbook(["A"]),
		);
		expect(result.warnings[0]?.missing).toEqual(["verification"]);
	});

	it("applies whatever gates the playbook declares, and never under a horizontal cut", () => {
		const roster = [entry({ roles: ["domain"] })];
		expect(
			computeCoherence(
				{ cut: "vertical", roster },
				{ wavesApplicable: ["A"], gates: [] },
			).warnings,
		).toHaveLength(1);
		expect(
			computeCoherence({ cut: "horizontal", roster }, playbook(["A"])).warnings,
		).toEqual([]);
	});
});

describe("classifyGlob", () => {
	it.each([
		["**", { kind: "all" }],
		["**/*", { kind: "all" }],
		["src/db/**", { kind: "prefix", segments: ["src", "db"] }],
		["packages/shared/", { kind: "prefix", segments: ["packages", "shared"] }],
		["./src/**", { kind: "prefix", segments: ["src"] }],
		["package.json", { kind: "file", segments: ["package.json"] }],
		["src/app.ts", { kind: "file", segments: ["src", "app.ts"] }],
		["**/*.spec.ts", { kind: "leaf", leaf: "*.spec.ts" }],
		["**/package.json", { kind: "leaf", leaf: "package.json" }],
		["src/*/index.ts", { kind: "unknown" }],
		["src/*", { kind: "unknown" }],
		["src/**/test/**", { kind: "unknown" }],
		["**/*.{ts,tsx}", { kind: "unknown" }],
		["**/?.ts", { kind: "unknown" }],
		["!src/**", { kind: "unknown" }],
		["src//db/**", { kind: "unknown" }],
		["../outside/**", { kind: "unknown" }],
	])("%s", (glob, expected) => {
		expect(classifyGlob(glob)).toEqual(expected);
	});
});

describe("globsOverlap", () => {
	it.each([
		// ** meets everything, even an undecidable glob
		["**", "src/db/**", "overlap"],
		["**", "src/*/x.ts", "overlap"],
		// prefix, prefix: by segment, never by character
		["src/**", "src/db/**", "overlap"],
		["src/db/**", "src/db/**", "overlap"],
		["src/db/**", "src/dbx/**", "disjoint"],
		["src/db/**", "tests/**", "disjoint"],
		// file, prefix
		["src/db/schema.ts", "src/db/**", "overlap"],
		["src/app.ts", "src/db/**", "disjoint"],
		// file, file
		["src/app.ts", "src/app.ts", "overlap"],
		["src/app.ts", "src/index.ts", "disjoint"],
		// leaf, prefix: a matching file can always sit under the directory
		["**/*.spec.ts", "apps/api/src/modules/billing/**", "overlap"],
		// leaf, file
		["**/*.spec.ts", "src/a.spec.ts", "overlap"],
		["**/*.spec.ts", "src/a.ts", "disjoint"],
		// leaf, leaf
		["**/*.spec.ts", "**/*.test.ts", "disjoint"],
		["**/*.test.ts", "**/*.ts", "overlap"],
		["**/package.json", "**/package.json", "overlap"],
		["**/package.json", "**/tsconfig.json", "disjoint"],
		["**/package.json", "**/*.json", "overlap"],
		["**/package.json", "**/*.ts", "disjoint"],
		["**/a*b.ts", "**/*.ts", "unknown"],
		// anything with an undecidable glob
		["src/*/index.ts", "src/db/**", "unknown"],
		["**/*.{ts,tsx}", "tests/**", "unknown"],
	] as const)("%s and %s: %s", (a, b, expected) => {
		expect(globsOverlap(a, b)).toBe(expected);
		expect(globsOverlap(b, a)).toBe(expected);
	});
});

describe("pathSetsOverlap", () => {
	it("is disjoint only when every pair is", () => {
		expect(
			pathSetsOverlap(["src/db/**", "src/contract/**"], ["tests/**"]),
		).toBe("disjoint");
		expect(pathSetsOverlap([], ["**"])).toBe("disjoint");
	});

	it("is overlap when any pair overlaps, even beside an undecided pair", () => {
		expect(
			pathSetsOverlap(["src/*/x.ts", "src/db/**"], ["src/db/schema.ts"]),
		).toBe("overlap");
	});

	it("is unknown when no pair overlaps and one is undecided", () => {
		expect(pathSetsOverlap(["src/*/x.ts", "src/db/**"], ["tests/**"])).toBe(
			"unknown",
		);
	});
});
