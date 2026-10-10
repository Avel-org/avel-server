import { describe, expect, it } from "vitest";
import type { BriefInput } from "../../src/contract";
import { checkIntake } from "../../src/lib/intake-check";

/** A brief that passes rules 1 to 4: two requirements, each with a criterion. */
function brief(over: Partial<BriefInput> = {}): BriefInput {
	return {
		summary: "Online booking for a salon",
		requirements: [
			{ id: "R1", text: "A customer books a slot" },
			{ id: "R2", text: "The owner sees bookings" },
		],
		acceptanceCriteria: [
			{ id: "AC1", requirementId: "R1", text: "A booked slot disappears" },
			{ id: "AC2", requirementId: "R2", text: "The list shows the booking" },
			{ id: "AC3", requirementId: "R1", text: "A confirmation is shown" },
		],
		...over,
	};
}

const paths = (issues: ReturnType<typeof checkIntake>) =>
	issues.map((i) => i.path);

describe("checkIntake", () => {
	it("passes a complete brief with no open questions", () => {
		expect(checkIntake({ proposedBrief: brief(), openQuestions: [] })).toEqual(
			[],
		);
		expect(
			checkIntake({
				proposedBrief: brief(),
				openQuestions: [],
				acknowledged: [],
			}),
		).toEqual([]);
	});

	it("rule 1: refuses a missing brief", () => {
		for (const proposedBrief of [null, undefined]) {
			expect(paths(checkIntake({ proposedBrief, openQuestions: [] }))).toEqual([
				["proposedBrief"],
			]);
		}
	});

	it("rule 1: refuses a brief that is not the brief shape, naming where", () => {
		const issues = checkIntake({
			proposedBrief: {
				...brief(),
				requirements: [{ id: "REQ-1", text: "x" }],
				extra: true,
			},
			openQuestions: [],
		});
		expect(paths(issues)).toEqual(
			expect.arrayContaining([
				["proposedBrief", "requirements", 0, "id"],
				["proposedBrief"],
			]),
		);
		expect(issues.length).toBe(2);
	});

	it("rule 2: refuses a brief with no requirements", () => {
		const issues = checkIntake({
			proposedBrief: brief({ requirements: [], acceptanceCriteria: [] }),
			openQuestions: [],
		});
		expect(paths(issues)).toEqual([["proposedBrief", "requirements"]]);
	});

	it("rule 2: refuses a repeated requirement id or criterion id", () => {
		const b = brief();
		const issues = checkIntake({
			proposedBrief: {
				...b,
				requirements: [...b.requirements, { id: "R1", text: "again" }],
				acceptanceCriteria: [
					...b.acceptanceCriteria,
					{ id: "AC2", requirementId: "R2", text: "again" },
				],
			},
			openQuestions: [],
		});
		expect(paths(issues)).toEqual([
			["proposedBrief", "requirements", 2, "id"],
			["proposedBrief", "acceptanceCriteria", 3, "id"],
		]);
	});

	it("rule 3: refuses a criterion that cites no requirement", () => {
		const b = brief();
		const issues = checkIntake({
			proposedBrief: {
				...b,
				acceptanceCriteria: [
					...b.acceptanceCriteria,
					{ id: "AC4", requirementId: "R9", text: "orphan" },
				],
			},
			openQuestions: [],
		});
		expect(paths(issues)).toEqual([
			["proposedBrief", "acceptanceCriteria", 3, "requirementId"],
		]);
		expect(issues[0]?.message).toContain("R9");
	});

	it("rule 4: refuses a requirement with no criterion", () => {
		const b = brief();
		const issues = checkIntake({
			proposedBrief: {
				...b,
				acceptanceCriteria: b.acceptanceCriteria.filter(
					(ac) => ac.requirementId !== "R2",
				),
			},
			openQuestions: [],
		});
		expect(paths(issues)).toEqual([["proposedBrief", "requirements", 1]]);
		expect(issues[0]?.message).toContain("R2");
	});

	it("rule 5: does not apply without acknowledged, as at propose", () => {
		expect(
			checkIntake({ proposedBrief: brief(), openQuestions: ["Deposits?"] }),
		).toEqual([]);
	});

	it("rule 5: refuses an unacknowledged question and a stale acknowledgement", () => {
		const issues = checkIntake({
			proposedBrief: brief(),
			openQuestions: ["Deposits?", "Which calendar?"],
			acknowledged: ["Which calendar?", "Gift cards?"],
		});
		expect(paths(issues)).toEqual([
			["openQuestions", 0],
			["acknowledged", 1],
		]);
		expect(
			checkIntake({
				proposedBrief: brief(),
				openQuestions: ["Deposits?", "Which calendar?"],
				acknowledged: ["Which calendar?", "Deposits?"],
			}),
		).toEqual([]);
	});

	it("reports every rule's issues together, in rule order", () => {
		const issues = checkIntake({
			proposedBrief: brief({
				requirements: [{ id: "R1", text: "only" }],
				acceptanceCriteria: [{ id: "AC1", requirementId: "R2", text: "x" }],
			}),
			openQuestions: ["Deposits?"],
			acknowledged: [],
		});
		expect(paths(issues)).toEqual([
			["proposedBrief", "acceptanceCriteria", 0, "requirementId"],
			["proposedBrief", "requirements", 0],
			["openQuestions", 0],
		]);
	});
});

describe("checkIntake rule 6", () => {
	it("refuses a brief that carries modules, since the plan adds them", () => {
		expect(
			checkIntake({
				proposedBrief: brief({
					modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"] }],
				}),
				openQuestions: [],
			}),
		).toEqual([
			{
				path: ["proposedBrief", "modules"],
				message:
					"An intake's brief has no modules; the mission's plan adds them",
			},
		]);
	});

	it("passes an empty modules list", () => {
		expect(
			checkIntake({ proposedBrief: brief({ modules: [] }), openQuestions: [] }),
		).toEqual([]);
	});
});

describe("shape issues are worded like the other rules", () => {
	const messages = (proposedBrief: unknown) =>
		checkIntake({ proposedBrief, openQuestions: [] }).map((i) => i.message);

	it("names a missing top-level field", () => {
		expect(messages({ summary: "Notifications." })).toEqual([
			"The brief has no requirements",
			"The brief has no acceptance criteria",
		]);
	});

	it("names the item and field, counted from 1", () => {
		expect(
			messages(
				brief({
					requirements: [
						{ id: "R1", text: "A client books a slot" },
						{ id: "R2" } as never,
					],
				}),
			),
		).toEqual(["Requirement 2's text is missing"]);
		expect(messages(brief({ summary: "" }))).toEqual(["The summary is empty"]);
	});

	it("names fields the brief does not use, and keeps the schema's own id wording", () => {
		expect(messages({ ...brief(), extra: 1 })).toEqual([
			"The brief has fields the brief does not use: extra",
		]);
		expect(
			messages(
				brief({
					requirements: [
						{ id: "X1", text: "A client books a slot" },
						{ id: "R2", text: "A stylist sees the day's bookings" },
					],
				}),
			),
		).toEqual(["A requirement id is R and a number: R1, R2, ..."]);
	});
});
