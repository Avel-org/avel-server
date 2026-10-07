import { describe, expect, it } from "vitest";
import {
	grain,
	isMissionAttachable,
	missionSkillSource,
	resolveSkillTiers,
	type SkillListItem,
} from "../../src/contract";
import {
	grain as grainEnum,
	missionSkillSource as missionSkillSourceEnum,
} from "../../src/db/schema";

type TierInput = Pick<SkillListItem, "status" | "layer" | "recommendedFor"> & {
	slug: string;
};

const skills: TierInput[] = [
	{
		slug: "drizzle",
		status: "approved",
		layer: "stack",
		recommendedFor: ["schema"],
	},
	{
		slug: "booking",
		status: "approved",
		layer: "domain",
		recommendedFor: ["domain"],
	},
	{
		slug: "fast-check",
		status: "approved",
		layer: "role",
		recommendedFor: ["property-tests"],
	},
	{
		slug: "draft",
		status: "draft",
		layer: "stack",
		recommendedFor: ["schema"],
	},
	{
		slug: "retired",
		status: "retired",
		layer: "domain",
		recommendedFor: ["domain"],
	},
	{
		slug: "luxon",
		status: "approved",
		layer: "stack",
		recommendedFor: ["interface"],
	},
];

const slugs = (xs: TierInput[]) => xs.map((s) => s.slug);

describe("loadout vocabularies", () => {
	it("match the database enums", () => {
		expect(grain.options).toEqual(grainEnum.enumValues);
		expect(missionSkillSource.options).toEqual(
			missionSkillSourceEnum.enumValues,
		);
	});
});

describe("isMissionAttachable", () => {
	it("takes approved stack and domain skills only", () => {
		expect(skills.filter(isMissionAttachable).map((s) => s.slug)).toEqual([
			"drizzle",
			"booking",
			"luxon",
		]);
	});
});

describe("resolveSkillTiers", () => {
	it("recommends attachable skills for any of the agent's roles, in input order", () => {
		const tiers = resolveSkillTiers(["schema", "interface"], skills);
		expect(slugs(tiers.recommended)).toEqual(["drizzle", "luxon"]);
		expect(slugs(tiers.available)).toEqual(["booking"]);
		expect(slugs(tiers.all)).toEqual(slugs(skills));
	});

	it("never offers a role-layer, draft or retired skill as attachable", () => {
		const tiers = resolveSkillTiers(["property-tests", "domain"], skills);
		expect(slugs(tiers.recommended)).toEqual(["booking"]);
		expect(slugs(tiers.available)).toEqual(["drizzle", "luxon"]);
	});

	it("offers everything attachable as available to an agent with no matching role", () => {
		const tiers = resolveSkillTiers([], skills);
		expect(tiers.recommended).toEqual([]);
		expect(slugs(tiers.available)).toEqual(["drizzle", "booking", "luxon"]);
	});

	it("does not alias the input array", () => {
		const tiers = resolveSkillTiers([], skills);
		expect(tiers.all).not.toBe(skills);
	});
});
