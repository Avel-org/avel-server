import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_RUNNER, ROLES } from "../../src/contract";
import {
	identitySupported,
	mergeAllowed,
	ROLE_DEFINITIONS,
	roleSide,
	sidesOf,
} from "../../src/lib/roles";

// The catalog rows in docs/ROLES.md: slug, runtime, produces, consumes,
// measured by. The definitions copy those cells, so a doc edit that is not
// carried into roles.ts fails here instead of drifting (F3).
function catalogRows(): Map<string, string[]> {
	const text = readFileSync("docs/ROLES.md", "utf-8");
	const rows = new Map<string, string[]>();
	for (const line of text.split("\n")) {
		const m = line.match(/^\| `([a-z-]+)` \| (model|code|human) \|/);
		if (!m) continue;
		const cells = line
			.trim()
			.slice(1, -1)
			.split(" | ")
			.map((c) => c.trim());
		rows.set(m[1] as string, cells);
	}
	return rows;
}

const modelRoles = ROLES.filter((r) => ROLE_RUNNER[r] === "model");
const otherRoles = ROLES.filter((r) => ROLE_RUNNER[r] !== "model");

describe("ROLE_DEFINITIONS", () => {
	it("defines every role, and nothing else", () => {
		expect(Object.keys(ROLE_DEFINITIONS).sort()).toEqual([...ROLES].sort());
	});

	const rows = catalogRows();
	it("finds all 35 catalog rows in ROLES.md", () => {
		expect(rows.size).toBe(35);
	});

	describe.each(ROLES)("%s", (role) => {
		const def = ROLE_DEFINITIONS[role];
		const cells = rows.get(role) as string[];

		it("matches its catalog row in ROLES.md", () => {
			expect(cells).toBeDefined();
			const [, runtime, produces, consumes, measuredBy] = cells;
			expect(ROLE_RUNNER[role]).toBe(runtime);
			expect(def.produces).toBe(produces);
			expect(def.consumes.join(", ")).toBe(consumes);
			expect(def.measuredBy).toBe(measuredBy);
		});

		it("carries guidance only if it is a model role", () => {
			if (ROLE_RUNNER[role] === "model") {
				expect(def.guidance.length).toBeGreaterThan(0);
				for (const line of def.guidance) expect(line).toMatch(/\b[Yy]our?\b/);
				expect(new Set(def.guidance).size).toBe(def.guidance.length);
			} else {
				expect(def.guidance).toEqual([]);
			}
		});
	});

	it("leaves checkedBy null only where ROLES.md states none", () => {
		const unchecked = ROLES.filter(
			(r) => ROLE_DEFINITIONS[r].checkedBy === null,
		);
		// Firm's Checked by names intake only; Platform's is an open question.
		expect(unchecked).toEqual([
			"strategy",
			"research",
			"client-ops",
			"knowledge",
			"render",
			"ship-decision",
		]);
	});

	it("tells each side what it never writes", () => {
		for (const role of modelRoles) {
			const text = ROLE_DEFINITIONS[role].guidance.join("\n");
			const side = roleSide(role);
			if (side === "author") expect(text).toContain("You never write tests");
			if (side === "tester" || side === "judge")
				expect(text).toMatch(/You never write source/);
			if (side === "fixture")
				expect(text).toContain("never render source or render output");
		}
	});

	it("points each model judge in Review at its own findings directory", () => {
		for (const role of modelRoles) {
			if (roleSide(role) !== "judge" || role === "incident-response") continue;
			expect(ROLE_DEFINITIONS[role].guidance.join("\n")).toContain(
				`\`findings/${role}/\``,
			);
		}
	});
});

describe("sidesOf", () => {
	it("lists distinct sides in SIDES order, skipping roles with none", () => {
		expect(sidesOf([])).toEqual([]);
		expect(sidesOf(["intake", "deploy"])).toEqual([]);
		expect(sidesOf(["spec-judgment", "domain", "schema"])).toEqual([
			"author",
			"judge",
		]);
		expect(sidesOf(["fixture", "backend-tests", "domain"])).toEqual([
			"author",
			"tester",
			"fixture",
		]);
	});
});

// ROSTER-V2.md, Merging roles into agents: the merge table, row by row.
describe("mergeAllowed", () => {
	it("Author + author: yes (Atlas · feature)", () => {
		expect(
			mergeAllowed([
				"schema",
				"contract",
				"domain",
				"api-surface",
				"auth",
				"state",
				"interface",
			]),
		).toEqual({ ok: true });
		expect(mergeAllowed(["design-system", "domain"])).toEqual({ ok: true });
	});

	it("Author + tester: never", () => {
		expect(mergeAllowed(["domain", "backend-tests"])).toEqual({
			ok: false,
			sides: ["author", "tester"],
		});
		expect(mergeAllowed(["schema", "property-tests"])).toEqual({
			ok: false,
			sides: ["author", "tester"],
		});
	});

	it("Tester + judge: never", () => {
		expect(mergeAllowed(["frontend-tests", "spec-judgment"])).toEqual({
			ok: false,
			sides: ["tester", "judge"],
		});
	});

	it("Author + judge: never, incident-response included", () => {
		expect(mergeAllowed(["interface", "security-review"])).toEqual({
			ok: false,
			sides: ["author", "judge"],
		});
		expect(mergeAllowed(["domain", "incident-response"])).toEqual({
			ok: false,
			sides: ["author", "judge"],
		});
	});

	it("Fixture + anything: never", () => {
		for (const other of ROLES) {
			if (other === "fixture") continue;
			expect(mergeAllowed(["fixture", other]).ok, other).toBe(false);
		}
		expect(mergeAllowed(["fixture"])).toEqual({ ok: true });
		expect(mergeAllowed(["fixture", "fixture"])).toEqual({ ok: true });
	});

	it("allows the roster's real merges within a side", () => {
		expect(mergeAllowed(["backend-tests", "frontend-tests"])).toEqual({
			ok: true,
		});
		expect(mergeAllowed(["security-review", "compliance-review"])).toEqual({
			ok: true,
		});
		expect(mergeAllowed(["api-surface", "integration", "realtime"])).toEqual({
			ok: true,
		});
		expect(mergeAllowed(["intake", "strategy"])).toEqual({ ok: true });
	});
});

describe("identitySupported", () => {
	it("is false for foundations: the operator gets no identity", () => {
		expect(identitySupported(["foundations"])).toBe(false);
	});

	it("is true for each model role alone, false for each other role", () => {
		for (const r of modelRoles) expect(identitySupported([r]), r).toBe(true);
		for (const r of otherRoles) expect(identitySupported([r]), r).toBe(false);
	});

	it("is false when any role is not a model role, and for no roles", () => {
		expect(identitySupported(["domain", "schema"])).toBe(true);
		expect(identitySupported(["schema", "foundations"])).toBe(false);
		expect(identitySupported(["spec-judgment", "spec-check"])).toBe(false);
		expect(identitySupported([])).toBe(false);
	});
});
