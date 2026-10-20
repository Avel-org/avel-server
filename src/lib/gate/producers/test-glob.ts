import type { Role } from "../../../contract/agent-template";
import type { FileChange } from "../../../rooms/checkpoint";
import { matchesGlob, supportedGlob } from "../../../rooms/globs";
import { mergeAllowed, sidesOf } from "../../roles";
import type { GateFinding } from "../types";
import { byId } from "./shared";

export const TEST_GLOB_SOURCE = "checkpoint:test-glob";

/** Which gate carries the checkpoint. A checkpoint blocks on any gate, so this only places it. */
export const TEST_GLOB_GATE = "qa";

export type TestGlobInput = {
	dispatchId: string;
	/** The roles of the dispatch's roster entry. */
	roles: readonly Role[];
	/** Every path changed since the room's pinned commit (src/rooms/checkpoint.ts). */
	changes: readonly FileChange[];
	testGlobs: readonly string[];
	commitSha: string;
};

/**
 * Nothing that writes source writes the tests that grade it (ROSTER-V2, What
 * is fixed), and the other way round. By side (src/contract/role-labels.ts):
 * - author, judge and fixture: a write under a test glob fails. A judge never
 *   grades a file it wrote; the fixture writes only fixtures/golden/;
 * - tester: a write outside every test glob fails;
 * - roles with no side: no test-glob rule, so nothing is found.
 * A delete is a write to its path, and a rename a write to both its paths.
 * One finding per path, or one pass for a dispatch that changed nothing.
 * Roles that cannot merge, no roles, no test globs, or a glob the matcher does
 * not understand are an error: the checkpoint cannot be shown to hold.
 */
export function testGlobFindings(input: TestGlobInput): GateFinding[] {
	const base = {
		gate: TEST_GLOB_GATE,
		kind: "checkpoint",
		source: TEST_GLOB_SOURCE,
		commitSha: input.commitSha,
	} as const;
	const prefix = `checkpoint:test-glob:${input.dispatchId}`;
	const error = (subject: string): GateFinding[] => [
		{ ...base, id: prefix, subject, outcome: "error" },
	];

	if (input.roles.length === 0) return error("The dispatch has no roles");
	if (!mergeAllowed(input.roles).ok) {
		return error(
			`The roles span more than one side: ${input.roles.join(", ")}`,
		);
	}
	if (input.testGlobs.length === 0)
		return error("No test globs are configured");
	const unsupported = input.testGlobs.filter((g) => !supportedGlob(g));
	if (unsupported.length > 0) {
		return error(`Unsupported test globs: ${unsupported.join(", ")}`);
	}

	const [side] = sidesOf(input.roles);
	if (side === undefined) return [];
	const testerSide = side === "tester";

	if (input.changes.length === 0) {
		return [
			{ ...base, id: prefix, subject: "Changed nothing", outcome: "pass" },
		];
	}
	const touched = input.changes.flatMap((c) =>
		c.kind === "renamed"
			? [
					{ path: c.from, how: `renamed to ${c.path}` },
					{ path: c.path, how: `renamed from ${c.from}` },
				]
			: [{ path: c.path, how: c.kind }],
	);
	return byId(
		touched.map(({ path, how }) => {
			const isTest = input.testGlobs.some((g) => matchesGlob(path, g));
			const ok = testerSide ? isTest : !isTest;
			return {
				...base,
				id: `${prefix}:${path}`,
				subject: ok
					? `${path} (${how})`
					: testerSide
						? `${path} (${how}): a ${side} wrote outside the test globs`
						: `${path} (${how}): a ${side} wrote under a test glob`,
				outcome: ok ? "pass" : "fail",
			};
		}),
	);
}
