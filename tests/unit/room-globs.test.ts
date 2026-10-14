import { describe, expect, it } from "vitest";
import { matchesGlob, writable } from "../../src/rooms/globs";

describe("matchesGlob", () => {
	const cases: Array<[string, string, boolean]> = [
		["src/a.ts", "src/**", true],
		["src/a/b/c.ts", "src/**", true],
		["src/.env", "src/**", true],
		["src", "src/**", true],
		["srcx/a.ts", "src/**", false],
		["src/a.ts", "src/", true],
		["src/deep/a.ts", "./src/", true],
		["a.spec.ts", "**/*.spec.ts", true],
		["x/y/a.spec.ts", "**/*.spec.ts", true],
		["x/y/a.ts", "**/*.spec.ts", false],
		["src/a.ts", "src/*.ts", true],
		["src/b/a.ts", "src/*.ts", false],
		["src/ab.ts", "src/a?.ts", true],
		["src/a.ts", "src/a?.ts", false],
		["src/a/b.ts", "src/a?b.ts", false],
		["src/A.ts", "src/a.ts", false],
		["src/a.ts", "src/a.ts", true],
		["src/aXts", "src/a.ts", false],
		["src/db/x.ts", "src/**/x.ts", true],
		["src/x.ts", "src/**/x.ts", true],
		["anything/at/all", "**", true],
	];
	for (const [path, glob, expected] of cases) {
		it(`${glob} ${expected ? "matches" : "does not match"} ${path}`, () => {
			expect(matchesGlob(path, glob)).toBe(expected);
		});
	}

	it("fails closed on what it does not support", () => {
		for (const glob of [
			"src/{a,b}.ts",
			"src/[ab].ts",
			"!src/**",
			"/src/**",
			"src/../x/**",
			"src\\**",
			"",
			"  ",
		]) {
			expect(matchesGlob("src/a.ts", glob), glob).toBe(false);
		}
	});
});

describe("writable", () => {
	it("is any glob, and none is nothing", () => {
		expect(writable("tests/a.ts", ["src/**", "tests/**"])).toBe(true);
		expect(writable("docs/a.md", ["src/**", "tests/**"])).toBe(false);
		expect(writable("src/a.ts", [])).toBe(false);
	});
});
