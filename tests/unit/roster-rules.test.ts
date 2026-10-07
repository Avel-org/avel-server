import { describe, expect, it } from "vitest";
import {
	addRosterEntryBody,
	FIRM_ROLES,
	ROLES,
	type RosterEntryFields,
	rosterEntryProblems,
	updateRosterEntryBody,
} from "../../src/contract";

const ok: RosterEntryFields = {
	grain: "default",
	absorbedBoundaries: [],
	estimatedTokens: 100,
	tokenSoftCeiling: 150,
	tokenHardCeiling: 300,
};

const paths = (f: RosterEntryFields) =>
	rosterEntryProblems(f).map((p) => p.path.join("."));

describe("FIRM_ROLES", () => {
	it("is the Firm family from ROLES.md, all in the role vocabulary", () => {
		expect(FIRM_ROLES).toEqual([
			"intake",
			"strategy",
			"research",
			"client-ops",
		]);
		for (const r of FIRM_ROLES) expect(ROLES).toContain(r);
	});
});

describe("rosterEntryProblems", () => {
	it("accepts a consistent entry, and unset ceilings", () => {
		expect(rosterEntryProblems(ok)).toEqual([]);
		expect(
			rosterEntryProblems({
				...ok,
				estimatedTokens: null,
				tokenSoftCeiling: null,
				tokenHardCeiling: null,
			}),
		).toEqual([]);
		expect(
			rosterEntryProblems({
				...ok,
				grain: "merged",
				absorbedBoundaries: ["calendar"],
			}),
		).toEqual([]);
	});

	it("ties absorbed boundaries to the merged grain, both ways", () => {
		expect(paths({ ...ok, grain: "merged" })).toEqual(["absorbedBoundaries"]);
		expect(paths({ ...ok, grain: "split", absorbedBoundaries: ["x"] })).toEqual(
			["absorbedBoundaries"],
		);
	});

	it("orders estimate, soft and hard ceilings", () => {
		expect(paths({ ...ok, tokenSoftCeiling: 50 })).toEqual([
			"tokenSoftCeiling",
		]);
		expect(paths({ ...ok, tokenHardCeiling: 120 })).toEqual([
			"tokenHardCeiling",
		]);
		expect(
			paths({ ...ok, tokenSoftCeiling: null, tokenHardCeiling: 50 }),
		).toEqual(["tokenHardCeiling"]);
		expect(
			paths({ ...ok, estimatedTokens: null, tokenHardCeiling: 100 }),
		).toEqual(["tokenHardCeiling"]);
	});
});

describe("roster bodies", () => {
	const templateId = "00000000-0000-4000-8000-000000000001";

	it("needs only a template to add, and refuses unknown keys", () => {
		expect(addRosterEntryBody.parse({ agentTemplateId: templateId })).toEqual({
			agentTemplateId: templateId,
		});
		expect(
			addRosterEntryBody.safeParse({
				agentTemplateId: templateId,
				missionId: "x",
			}).success,
		).toBe(false);
		expect(
			addRosterEntryBody.safeParse({ agentTemplateId: templateId, waves: [] })
				.success,
		).toBe(false);
	});

	it("never lets an update change the template, and needs one field", () => {
		expect(
			updateRosterEntryBody.safeParse({ agentTemplateId: templateId }).success,
		).toBe(false);
		expect(updateRosterEntryBody.safeParse({}).success).toBe(false);
		expect(updateRosterEntryBody.safeParse({ active: false }).success).toBe(
			true,
		);
	});
});
