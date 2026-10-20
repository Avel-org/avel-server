import { describe, expect, it } from "vitest";
import { checkCanonAnswer } from "../../src/lib/canon-answer";

const options = [
	{ label: "GitHub", description: "OAuth" },
	{ label: "Email", description: "Magic link" },
	{ label: "Both", description: "Either" },
];
const single = { options, multiSelect: false };
const multi = { options, multiSelect: true };
const paths = (issues: ReturnType<typeof checkCanonAnswer>) =>
	issues.map((i) => i.path.join("."));

describe("checkCanonAnswer", () => {
	it("passes one label, or other alone, on a single-select question", () => {
		expect(checkCanonAnswer(single, { selected: ["GitHub"] })).toEqual([]);
		expect(
			checkCanonAnswer(single, { selected: [], other: "SAML, later" }),
		).toEqual([]);
	});

	it("passes one or more labels, other, or both, on a multi-select question", () => {
		expect(checkCanonAnswer(multi, { selected: ["GitHub"] })).toEqual([]);
		expect(checkCanonAnswer(multi, { selected: ["GitHub", "Email"] })).toEqual(
			[],
		);
		expect(checkCanonAnswer(multi, { selected: [], other: "SAML" })).toEqual(
			[],
		);
		expect(
			checkCanonAnswer(multi, { selected: ["Email"], other: "SAML" }),
		).toEqual([]);
	});

	it("refuses a label the question does not offer, and one given twice", () => {
		expect(
			paths(
				checkCanonAnswer(multi, { selected: ["GitHub", "Okta", "github"] }),
			),
		).toEqual(["answer.selected.1", "answer.selected.2"]);
		expect(
			paths(checkCanonAnswer(multi, { selected: ["Email", "Email"] })),
		).toEqual(["answer.selected.1"]);
	});

	it("refuses more than one label, or a label with other, on a single-select question", () => {
		expect(
			paths(checkCanonAnswer(single, { selected: ["GitHub", "Email"] })),
		).toEqual(["answer.selected"]);
		expect(
			paths(checkCanonAnswer(single, { selected: ["GitHub"], other: "SAML" })),
		).toEqual(["answer.selected"]);
	});

	it("refuses an empty answer, and a blank other", () => {
		for (const q of [single, multi]) {
			expect(paths(checkCanonAnswer(q, { selected: [] }))).toEqual([
				"answer.selected",
			]);
			expect(paths(checkCanonAnswer(q, { selected: [], other: "  " }))).toEqual(
				["answer.other"],
			);
		}
	});

	it("refuses an answer that is not the answer shape", () => {
		for (const bad of [
			null,
			"GitHub",
			{},
			{ selected: "GitHub" },
			{ selected: [1] },
			{ selected: [], other: 2 },
			{ selected: ["GitHub"], extra: true },
		]) {
			const issues = checkCanonAnswer(single, bad);
			expect(issues.length, JSON.stringify(bad)).toBeGreaterThan(0);
			expect(issues.every((i) => i.path[0] === "answer")).toBe(true);
		}
	});

	it("is pure: the same input gives the same issues in the same order", () => {
		const answer = { selected: ["Okta", "GitHub", "Okta"], other: " " };
		expect(checkCanonAnswer(multi, answer)).toEqual(
			checkCanonAnswer(multi, answer),
		);
	});
});
