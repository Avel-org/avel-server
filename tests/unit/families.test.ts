import { describe, expect, it } from "vitest";
import {
	AGENT_RESOURCES,
	AGENT_VERBS,
	ROLE_RUNNER,
	ROLE_TEAM,
	ROLES,
} from "../../src/contract";
import { agentFamilyOf, agentMay, FAMILY_ACCESS } from "../../src/lib/families";

const modelRoles = ROLES.filter((r) => ROLE_RUNNER[r] === "model");
const otherRoles = ROLES.filter((r) => ROLE_RUNNER[r] !== "model");

/** Every resource and verb pair a route could declare. */
const everyAction = AGENT_VERBS.flatMap((verb) =>
	AGENT_RESOURCES.map((resource) => ({ verb, resource })),
);

describe("FAMILY_ACCESS", () => {
	// ROLES.md: a role without a family row is refused everything.
	it("has a row for the family of every model role", () => {
		for (const role of modelRoles) {
			expect(Object.hasOwn(FAMILY_ACCESS, ROLE_TEAM[role]), role).toBe(true);
			expect(agentFamilyOf(role), role).toBe(ROLE_TEAM[role]);
		}
	});

	it("gives code roles and foundations no family and nothing to do", () => {
		expect(otherRoles).toContain("foundations");
		expect(otherRoles).toContain("spec-check");
		for (const role of otherRoles) {
			expect(agentFamilyOf(role), role).toBeNull();
			for (const action of everyAction) {
				expect(agentMay([role], action), `${role} ${action.verb}`).toBe(false);
			}
		}
	});

	it("holds the ROLES.md table: read the dispatch, act the report, propose nothing", () => {
		const mission = { read: ["dispatch"], propose: [] };
		expect(FAMILY_ACCESS).toEqual({
			foundation: { ...mission, act: ["completion_report"] },
			build: { ...mission, act: ["completion_report"] },
			verify: { ...mission, act: ["completion_report"] },
			review: { ...mission, act: ["completion_report", "finding"] },
			operate: { read: [], act: [], propose: [] },
			firm: { read: [], act: [], propose: [] },
		});
	});
});

describe("agentMay", () => {
	it("lets a Review role act a finding, and not a Build or Verify role", () => {
		const finding = { resource: "finding", verb: "act" } as const;
		expect(agentMay(["security-review"], finding)).toBe(true);
		expect(agentMay(["domain"], finding)).toBe(false);
		expect(agentMay(["backend-tests"], finding)).toBe(false);
	});

	it("lets every mission family read its dispatch and act its report", () => {
		for (const role of [
			"schema",
			"domain",
			"backend-tests",
			"spec-judgment",
		] as const) {
			expect(agentMay([role], { resource: "dispatch", verb: "read" })).toBe(
				true,
			);
			expect(
				agentMay([role], { resource: "completion_report", verb: "act" }),
			).toBe(true);
			expect(
				agentMay([role], { resource: "completion_report", verb: "read" }),
			).toBe(false);
		}
	});

	it("refuses Operate and Firm everything until their modules", () => {
		for (const role of ["incident-response", "intake", "strategy"] as const) {
			for (const action of everyAction) {
				expect(agentMay([role], action), `${role} ${action.verb}`).toBe(false);
			}
		}
	});

	it("gives an agent spanning roles the union of their families", () => {
		const finding = { resource: "finding", verb: "act" } as const;
		const dispatch = { resource: "dispatch", verb: "read" } as const;
		// A code role never lends its family: spec-check is Review, but code.
		expect(agentMay(["spec-check"], finding)).toBe(false);
		expect(agentMay(["intake", "spec-judgment"], finding)).toBe(true);
		expect(agentMay(["spec-judgment", "intake"], finding)).toBe(true);
		expect(agentMay(["intake", "domain"], dispatch)).toBe(true);
		expect(agentMay(["intake", "strategy"], dispatch)).toBe(false);
	});

	it("refuses an agent with no roles", () => {
		expect(agentMay([], { resource: "dispatch", verb: "read" })).toBe(false);
	});
});
