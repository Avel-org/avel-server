import { describe, expect, it } from "vitest";
import type { Brief } from "../../src/contract";
import { approvedBriefChanges, checkPlan } from "../../src/lib/plan-check";

/** A plan that passes: two requirements, each with a criterion, in two modules. */
function plan(over: Partial<Brief> = {}): Brief {
	return {
		summary: "Online booking for a salon",
		requirements: [
			{ id: "R1", text: "A client books a slot" },
			{ id: "R2", text: "A stylist sees the day's bookings" },
		],
		acceptanceCriteria: [
			{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
			{ id: "AC2", requirementId: "R2", text: "The day view lists bookings" },
		],
		modules: [
			{ id: "M1", name: "Booking", requirementIds: ["R1"] },
			{ id: "M2", name: "Schedule", requirementIds: ["R2"] },
		],
		...over,
	};
}

const messages = (brief: unknown) => checkPlan(brief).map((i) => i.message);

describe("checkPlan", () => {
	it("passes a complete plan", () => {
		expect(checkPlan(plan())).toEqual([]);
	});

	it("reports a missing brief and stops", () => {
		expect(checkPlan(null)).toEqual([
			{ path: ["brief"], message: "There is no brief yet" },
		]);
	});

	it("reports a brief of the wrong shape under brief, and runs no module rule", () => {
		const issues = checkPlan({ summary: "x" });
		expect(issues.length).toBeGreaterThan(0);
		for (const i of issues) expect(i.path[0]).toBe("brief");
		expect(issues.map((i) => i.message)).not.toContain(
			"The plan has no modules",
		);
	});

	it("keeps intake's rules", () => {
		expect(
			messages(
				plan({
					acceptanceCriteria: [
						{ id: "AC1", requirementId: "R1", text: "Booking succeeds" },
					],
				}),
			),
		).toEqual(["R2 has no acceptance criterion"]);
	});

	it("tells a missing criterion from a module problem by path alone", () => {
		const issues = checkPlan(
			plan({
				acceptanceCriteria: [
					{ id: "AC1", requirementId: "R1", text: "Booking succeeds" },
				],
				modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"] }],
			}),
		);
		expect(issues.map((i) => i.path)).toEqual([
			["brief", "requirements", 1, "acceptanceCriteria"],
			["brief", "requirements", 1],
		]);
	});

	it("parses a stored brief without modules as having none", () => {
		const { modules: _, ...old } = plan();
		expect(messages(old)).toEqual([
			"The plan has no modules",
			"R1 is in no module",
			"R2 is in no module",
		]);
	});

	it("refuses a duplicate module id", () => {
		const issues = checkPlan(
			plan({
				modules: [
					{ id: "M1", name: "Booking", requirementIds: ["R1"] },
					{ id: "M1", name: "Schedule", requirementIds: ["R2"] },
				],
			}),
		);
		expect(issues).toEqual([
			{
				path: ["brief", "modules", 1, "id"],
				message: "Module id M1 is used more than once",
			},
		]);
	});

	it("refuses a module listing a requirement that does not exist", () => {
		expect(
			messages(
				plan({
					modules: [
						{ id: "M1", name: "Booking", requirementIds: ["R1", "R9"] },
						{ id: "M2", name: "Schedule", requirementIds: ["R2"] },
					],
				}),
			),
		).toEqual(["M1 lists R9, which is not a requirement"]);
	});

	it("refuses a module listing a requirement twice", () => {
		expect(
			messages(
				plan({
					modules: [
						{ id: "M1", name: "Booking", requirementIds: ["R1", "R1"] },
						{ id: "M2", name: "Schedule", requirementIds: ["R2"] },
					],
				}),
			),
		).toEqual(["M1 lists R1 more than once"]);
	});

	it("refuses a requirement in no module", () => {
		const issues = checkPlan(
			plan({
				modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"] }],
			}),
		);
		expect(issues).toEqual([
			{ path: ["brief", "requirements", 1], message: "R2 is in no module" },
		]);
	});

	it("refuses a requirement in two modules", () => {
		expect(
			messages(
				plan({
					modules: [
						{ id: "M1", name: "Booking", requirementIds: ["R1", "R2"] },
						{ id: "M2", name: "Schedule", requirementIds: ["R2"] },
					],
				}),
			),
		).toEqual(["R2 is in more than one module: M1, M2"]);
	});

	it("gives the same issues in the same order every run", () => {
		const bad = plan({
			modules: [
				{ id: "M1", name: "A", requirementIds: ["R9", "R1", "R1"] },
				{ id: "M1", name: "B", requirementIds: ["R1"] },
			],
		});
		expect(checkPlan(bad)).toEqual(checkPlan(structuredClone(bad)));
	});
});

describe("approvedBriefChanges", () => {
	const approved = plan({ modules: [] });

	it("allows adding modules, requirements and criteria", () => {
		const next = plan({
			requirements: [...approved.requirements, { id: "R3", text: "New" }],
			acceptanceCriteria: [
				...approved.acceptanceCriteria,
				{ id: "AC3", requirementId: "R3", text: "New works" },
			],
		});
		expect(approvedBriefChanges(approved, next)).toEqual([]);
	});

	it("refuses a changed summary", () => {
		expect(
			approvedBriefChanges(approved, plan({ summary: "Something else" })).map(
				(i) => i.message,
			),
		).toEqual(["The summary was approved and cannot change"]);
	});

	it("refuses a removed or reworded requirement", () => {
		const next = plan({
			requirements: [{ id: "R2", text: "Reworded" }],
		});
		expect(approvedBriefChanges(approved, next)).toEqual([
			{
				path: ["brief", "requirements"],
				message: "R1 was approved and cannot be removed",
			},
			{
				path: ["brief", "requirements", 0, "text"],
				message: "R2 was approved and its text cannot change",
			},
		]);
	});

	it("refuses a removed or re-pointed criterion", () => {
		const next = plan({
			acceptanceCriteria: [
				{ id: "AC2", requirementId: "R1", text: "The day view lists bookings" },
			],
		});
		expect(approvedBriefChanges(approved, next).map((i) => i.message)).toEqual([
			"AC1 was approved and cannot be removed",
			"AC2 was approved and cannot change",
		]);
	});
});

describe("approvedBriefChanges with duplicate ids", () => {
	const approved = plan({ modules: [] });

	it("refuses an approved requirement listed twice, even when one copy is unchanged", () => {
		const next = plan({
			requirements: [
				{ id: "R1", text: "REWRITTEN" },
				{ id: "R1", text: "A client books a slot" },
				{ id: "R2", text: "A stylist sees the day's bookings" },
			],
		});
		expect(approvedBriefChanges(approved, next)).toEqual([
			{
				path: ["brief", "requirements", 1, "id"],
				message: "R1 was approved and cannot appear more than once",
			},
		]);
	});

	it("refuses an approved criterion listed twice", () => {
		const next = plan({
			acceptanceCriteria: [
				{ id: "AC1", requirementId: "R2", text: "Moved" },
				...approved.acceptanceCriteria,
			],
		});
		expect(approvedBriefChanges(approved, next).map((i) => i.message)).toEqual([
			"AC1 was approved and cannot appear more than once",
		]);
	});
});
