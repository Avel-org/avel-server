import { describe, expect, it } from "vitest";
import {
	briefCheck,
	briefSchema,
	CHECK_KINDS,
	repoPath,
} from "../../src/contract";

const base = {
	summary: "Online booking for a salon",
	requirements: [{ id: "R1", text: "A client books a slot" }],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "Booking a free slot succeeds" },
	],
};

describe("the brief's step 9 sections", () => {
	it("parses a brief stored before step 9 with no reads and no checks", () => {
		const out = briefSchema.parse({
			...base,
			modules: [{ id: "M1", name: "Booking", requirementIds: ["R1"] }],
		});
		expect(out.checks).toEqual([]);
		expect(out.modules[0]?.reads).toEqual([]);
	});

	it("keeps a module's reads and the plan's checks", () => {
		const brief = {
			...base,
			modules: [
				{
					id: "M1",
					name: "Booking",
					requirementIds: ["R1"],
					reads: ["src/booking/**", "README.md"],
				},
			],
			checks: [
				{
					id: "CK1",
					requirementId: "R1",
					kind: "test",
					command: "pnpm vitest run tests/booking.test.ts",
				},
				{
					id: "CK2",
					requirementId: "R1",
					kind: "file_exists",
					path: "src/booking/slots.ts",
					note: "The slot model exists",
				},
			],
		};
		expect(briefSchema.parse(brief)).toEqual(brief);
	});

	it("lists the four check kinds", () => {
		expect(CHECK_KINDS).toEqual([
			"file_exists",
			"test",
			"typecheck",
			"command",
		]);
	});
});

describe("a check", () => {
	const ok = { id: "CK1", requirementId: "R1" };

	it("needs a path for file_exists and a command for every other kind", () => {
		expect(
			briefCheck.safeParse({ ...ok, kind: "file_exists", command: "ls" })
				.success,
		).toBe(false);
		for (const kind of ["test", "typecheck", "command"]) {
			expect(
				briefCheck.safeParse({ ...ok, kind, path: "src/a.ts" }).success,
			).toBe(false);
			expect(
				briefCheck.safeParse({ ...ok, kind, command: "pnpm tsc" }).success,
			).toBe(true);
		}
	});

	it("refuses an unknown kind, a bad id and an extra field", () => {
		expect(
			briefCheck.safeParse({ ...ok, kind: "vibes", command: "x" }).success,
		).toBe(false);
		expect(
			briefCheck.safeParse({
				...ok,
				id: "C1",
				kind: "test",
				command: "x",
			}).success,
		).toBe(false);
		expect(
			briefCheck.safeParse({
				...ok,
				kind: "test",
				command: "x",
				passed: true,
			}).success,
		).toBe(false);
	});
});

describe("a repository path", () => {
	it("takes relative paths and globs", () => {
		for (const p of ["src/a.ts", "src/**/*.ts", "README.md", "a\\b.ts"]) {
			expect(repoPath.safeParse(p).success).toBe(true);
		}
	});

	it("refuses absolute paths and .. segments", () => {
		for (const p of [
			"/etc/passwd",
			"\\\\server\\share",
			"C:\\Users",
			"c:/x",
			"../secrets",
			"src/../../x",
			"src\\..\\x",
			"",
			"   ",
		]) {
			expect(repoPath.safeParse(p).success, p).toBe(false);
		}
	});

	it("allows a name that only starts with two dots", () => {
		expect(repoPath.safeParse("..env.example").success).toBe(true);
	});
});
