import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ROLE_LABELS,
	ROLE_RUNNER,
	ROLE_SIDE,
	ROLE_TEAM,
	ROLES,
	type Role,
	TEAMS,
	type Team,
} from "../../src/contract";

// The catalog in docs/ROLES.md is the source: each family heading, then a
// table whose rows start with the role slug and its runtime.
const FAMILY_HEADINGS: Record<string, Team> = {
	Foundation: "foundation",
	Build: "build",
	Verify: "verify",
	Review: "review",
	Operate: "operate",
	Firm: "firm",
	Platform: "platform",
};

function catalog(): Map<Role, { team: Team; runner: string }> {
	const text = readFileSync("docs/ROLES.md", "utf-8");
	const found = new Map<Role, { team: Team; runner: string }>();
	let team: Team | null = null;
	for (const line of text.split("\n")) {
		const heading = /^### (\w+)/.exec(line);
		if (heading) team = FAMILY_HEADINGS[heading[1] ?? ""] ?? null;
		const [, slug, runner] =
			/^\| `([a-z-]+)` \| (model|code|human) \|/.exec(line) ?? [];
		if (slug && runner && team) found.set(slug as Role, { team, runner });
	}
	return found;
}

describe("role labels", () => {
	it("reads every role from the catalog", () => {
		expect([...catalog().keys()].sort()).toEqual([...ROLES].sort());
	});

	it("puts each role in its ROLES.md family", () => {
		for (const [r, { team }] of catalog())
			expect([r, ROLE_TEAM[r]]).toEqual([r, team]);
	});

	it("gives each role its ROLES.md runtime", () => {
		for (const [r, { runner }] of catalog())
			expect([r, ROLE_RUNNER[r]]).toEqual([r, runner]);
	});

	// ROSTER-V2, Merging roles into agents: the side follows the family.
	it("derives each side from the family and runtime", () => {
		for (const r of ROLES) {
			const team = ROLE_TEAM[r];
			const expected =
				r === "fixture"
					? "fixture"
					: r === "incident-response"
						? "judge"
						: ROLE_RUNNER[r] === "code" || team === "firm"
							? null
							: team === "foundation" || team === "build"
								? "author"
								: team === "verify"
									? "tester"
									: team === "review"
										? "judge"
										: null;
			expect([r, ROLE_SIDE[r]]).toEqual([r, expected]);
		}
	});

	it("labels every role once, with no two alike", () => {
		const labels = Object.values(ROLE_LABELS);
		expect(labels).toHaveLength(ROLES.length);
		expect(new Set(labels).size).toBe(labels.length);
		for (const l of labels) expect(l.trim()).toBe(l);
	});

	it("uses every team", () => {
		expect(new Set(Object.values(ROLE_TEAM))).toEqual(new Set(TEAMS));
	});
});
