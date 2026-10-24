import { describe, expect, it } from "vitest";
import {
	type IntegrationDispatch,
	planIntegration,
} from "../../../src/lib/gate/integration";
import { rng } from "./fixtures";

const BASE = "b".repeat(40);

function dispatch(
	id: string,
	closedAt: string,
	changes: IntegrationDispatch["changes"],
	status: IntegrationDispatch["status"] = "complete",
): IntegrationDispatch {
	return { id, status, closedAt: `2026-10-19T${closedAt}.000Z`, changes };
}

describe("planIntegration", () => {
	it("lays complete dispatches down in close order, each path once", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d2", "10:00:00", [
					{ kind: "added", path: "src/b.ts" },
					{ kind: "deleted", path: "src/old.ts" },
				]),
				dispatch("d1", "09:00:00", [
					{ kind: "modified", path: "src/a.ts" },
					{ kind: "renamed", from: "src/x.ts", path: "src/y.ts" },
				]),
			],
		});
		expect(plan).toEqual({
			ok: true,
			baseSha: BASE,
			steps: [
				{
					dispatchId: "d1",
					closedAt: "2026-10-19T09:00:00.000Z",
					startSha: BASE,
					ops: [
						{ op: "write", path: "src/a.ts" },
						{ op: "delete", path: "src/x.ts" },
						{ op: "write", path: "src/y.ts" },
					],
				},
				{
					dispatchId: "d2",
					closedAt: "2026-10-19T10:00:00.000Z",
					startSha: BASE,
					ops: [
						{ op: "write", path: "src/b.ts" },
						{ op: "delete", path: "src/old.ts" },
					],
				},
			],
			excluded: [],
		});
	});

	it("breaks a tie in close time by dispatch id", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d2", "09:00:00", [{ kind: "added", path: "b" }]),
				dispatch("d1", "09:00:00", [{ kind: "added", path: "a" }]),
			],
		});
		expect(plan.ok && plan.steps.map((s) => s.dispatchId)).toEqual([
			"d1",
			"d2",
		]);
	});

	it("writes a renamed-away path that the same dispatch adds again", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d1", "09:00:00", [
					{ kind: "renamed", from: "a.ts", path: "b.ts" },
					{ kind: "added", path: "a.ts" },
				]),
			],
		});
		expect(plan.ok && plan.steps[0]?.ops).toEqual([
			{ op: "write", path: "a.ts" },
			{ op: "write", path: "b.ts" },
		]);
	});

	it("is a conflict when two complete dispatches touch one path, listing every one", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d3", "11:00:00", [{ kind: "modified", path: "src/a.ts" }]),
				dispatch("d1", "09:00:00", [{ kind: "modified", path: "src/a.ts" }]),
				dispatch("d2", "10:00:00", [
					{ kind: "renamed", from: "src/a.ts", path: "src/z.ts" },
					{ kind: "deleted", path: "src/gone.ts" },
				]),
				dispatch("d4", "12:00:00", [
					{ kind: "deleted", path: "src/gone.ts" },
					{ kind: "added", path: "src/free.ts" },
				]),
			],
		});
		expect(plan).toEqual({
			ok: false,
			baseSha: BASE,
			conflicts: [
				{ path: "src/a.ts", dispatchIds: ["d1", "d2", "d3"] },
				{ path: "src/gone.ts", dispatchIds: ["d2", "d4"] },
			],
			excluded: [],
		});
	});

	// Decided 2026-10-22: rooms start from finished work.
	const START = "c".repeat(40);
	const startedOn = (
		d: IntegrationDispatch,
		saw: string[],
	): IntegrationDispatch => ({ ...d, startSha: START, saw });

	it("lets a dispatch that started from another's work change its file, laid down after it", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d1", "09:00:00", [{ kind: "added", path: "src/a.ts" }]),
				startedOn(
					dispatch("d2", "10:00:00", [{ kind: "modified", path: "src/a.ts" }]),
					["d1"],
				),
			],
		});
		expect(plan.ok).toBe(true);
		expect(
			plan.ok &&
				plan.steps.map((s) => [s.dispatchId, s.startSha, s.ops[0]?.path]),
		).toEqual([
			["d1", BASE, "src/a.ts"],
			["d2", START, "src/a.ts"],
		]);
	});

	it("still conflicts where neither saw the other, naming only the pairs that did not", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d1", "09:00:00", [{ kind: "added", path: "a" }]),
				// d2 and d3 both started from d1's work, but not from each other's.
				startedOn(
					dispatch("d2", "10:00:00", [{ kind: "modified", path: "a" }]),
					["d1"],
				),
				startedOn(
					dispatch("d3", "11:00:00", [{ kind: "modified", path: "a" }]),
					["d1"],
				),
				// d4 saw everything before it.
				startedOn(dispatch("d4", "12:00:00", [{ kind: "added", path: "b" }]), [
					"d1",
					"d2",
					"d3",
				]),
			],
		});
		expect(plan.ok === false && plan.conflicts).toEqual([
			{ path: "a", dispatchIds: ["d2", "d3"] },
		]);
	});

	it("refuses a start that is not a full sha", () => {
		expect(() =>
			planIntegration({
				baseSha: BASE,
				dispatches: [{ ...dispatch("d1", "09:00:00", []), startSha: "abc" }],
			}),
		).toThrow(/start/);
	});

	it("sorts conflicts by path and ids by id, whatever the close order", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("dz", "09:00:00", [{ kind: "modified", path: "z.ts" }]),
				dispatch("dy", "10:00:00", [{ kind: "modified", path: "a.ts" }]),
				dispatch("dx", "11:00:00", [
					{ kind: "modified", path: "z.ts" },
					{ kind: "modified", path: "a.ts" },
				]),
			],
		});
		expect(plan.ok === false && plan.conflicts).toEqual([
			{ path: "a.ts", dispatchIds: ["dx", "dy"] },
			{ path: "z.ts", dispatchIds: ["dx", "dz"] },
		]);
	});

	it("leaves out blocked, halted and failed dispatches, lists them, and never conflicts on them", () => {
		const plan = planIntegration({
			baseSha: BASE,
			dispatches: [
				dispatch("d1", "09:00:00", [{ kind: "modified", path: "a" }]),
				dispatch(
					"d2",
					"10:00:00",
					[{ kind: "modified", path: "a" }],
					"blocked",
				),
				dispatch("d3", "11:00:00", [{ kind: "modified", path: "a" }], "halted"),
				dispatch("d4", "08:00:00", [{ kind: "modified", path: "a" }], "failed"),
			],
		});
		expect(plan).toEqual({
			ok: true,
			baseSha: BASE,
			steps: [
				{
					dispatchId: "d1",
					closedAt: "2026-10-19T09:00:00.000Z",
					startSha: BASE,
					ops: [{ op: "write", path: "a" }],
				},
			],
			excluded: [
				{
					dispatchId: "d4",
					status: "failed",
					closedAt: "2026-10-19T08:00:00.000Z",
				},
				{
					dispatchId: "d2",
					status: "blocked",
					closedAt: "2026-10-19T10:00:00.000Z",
				},
				{
					dispatchId: "d3",
					status: "halted",
					closedAt: "2026-10-19T11:00:00.000Z",
				},
			],
		});
	});

	it("plans nothing when no dispatch completed", () => {
		expect(planIntegration({ baseSha: BASE, dispatches: [] })).toEqual({
			ok: true,
			baseSha: BASE,
			steps: [],
			excluded: [],
		});
	});

	it("refuses a base that is not a full sha, a repeated dispatch, or a close time out of format", () => {
		expect(() => planIntegration({ baseSha: "abc", dispatches: [] })).toThrow(
			/base/,
		);
		const d = dispatch("d1", "09:00:00", []);
		expect(() =>
			planIntegration({ baseSha: BASE, dispatches: [d, d] }),
		).toThrow(/more than once/);
		expect(() =>
			planIntegration({
				baseSha: BASE,
				dispatches: [{ ...d, closedAt: "2026-10-19 09:00" }],
			}),
		).toThrow(/closedAt/);
	});

	it("does not depend on the order of the dispatches or their changes", () => {
		const dispatches = [
			dispatch("d1", "09:00:00", [
				{ kind: "added", path: "a" },
				{ kind: "deleted", path: "b" },
				{ kind: "renamed", from: "c", path: "d" },
			]),
			dispatch("d2", "09:00:00", [{ kind: "modified", path: "e" }]),
			dispatch("d3", "10:00:00", [{ kind: "added", path: "a" }], "blocked"),
			dispatch("d4", "11:00:00", [
				{ kind: "added", path: "f" },
				{ kind: "modified", path: "g" },
			]),
		];
		const expected = planIntegration({ baseSha: BASE, dispatches });
		const r = rng(5);
		for (let i = 0; i < 30; i++) {
			const shuffled = r
				.shuffle(dispatches)
				.map((d) => ({ ...d, changes: r.shuffle(d.changes) }));
			expect(planIntegration({ baseSha: BASE, dispatches: shuffled })).toEqual(
				expected,
			);
		}
		const conflicting = [
			...dispatches,
			dispatch("d5", "12:00:00", [{ kind: "modified", path: "e" }]),
			dispatch("d6", "13:00:00", [{ kind: "deleted", path: "a" }]),
		];
		const conflict = planIntegration({
			baseSha: BASE,
			dispatches: conflicting,
		});
		for (let i = 0; i < 30; i++) {
			expect(
				planIntegration({ baseSha: BASE, dispatches: r.shuffle(conflicting) }),
			).toEqual(conflict);
		}
	});
});
