import { describe, expect, it } from "vitest";
import { decide, type GateFinding } from "../../../src/lib/gate";
import {
	DEFAULT_PROTECTED_PATHS,
	PROTECTED_PATHS_SOURCE,
	protectedPathFindings,
} from "../../../src/lib/gate/producers";
import { matchesGlob, supportedGlob } from "../../../src/rooms/globs";
import { config, override, rng, SHA } from "./fixtures";

const base = {
	".github/workflows/ci.yml": "w1",
	"vitest.config.ts": "v1",
	"src/a.ts": "a1",
	"package.json": "p1",
};

const run = (
	head: Record<string, string>,
	over: Partial<Parameters<typeof protectedPathFindings>[0]> = {},
) =>
	protectedPathFindings({
		protectedPaths: [".github/workflows/**", "vitest.config.*"],
		base,
		head,
		commitSha: SHA,
		// Both trees hold a package.json, so its scripts must be given.
		packageJsonScripts: { base: {}, head: {} },
		...over,
	});

const outcomes = (fs: GateFinding[]) =>
	fs.map((f) => `${f.id}:${"outcome" in f ? f.outcome : f.kind}`);

describe("protectedPathFindings", () => {
	it("passes once when nothing protected changed", () => {
		const fs = run({ ...base, "src/a.ts": "a2", "src/b.ts": "b1" });
		expect(outcomes(fs)).toEqual(["checkpoint:protected:pass"]);
		expect(fs[0]).toMatchObject({
			kind: "checkpoint",
			source: PROTECTED_PATHS_SOURCE,
			commitSha: SHA,
		});
	});

	it("fails a protected path that changed, was added, or was removed", () => {
		const head: Record<string, string> = {
			...base,
			"vitest.config.ts": "v2",
			".github/workflows/release.yml": "r1",
		};
		delete head[".github/workflows/ci.yml"];
		const fs = run(head);
		expect(outcomes(fs)).toEqual([
			"checkpoint:protected:.github/workflows/ci.yml:fail",
			"checkpoint:protected:.github/workflows/release.yml:fail",
			"checkpoint:protected:vitest.config.ts:fail",
		]);
		expect(fs.map((f) => f.subject)).toEqual([
			".github/workflows/ci.yml: removed (protected by .github/workflows/**)",
			".github/workflows/release.yml: added (protected by .github/workflows/**)",
			"vitest.config.ts: changed (protected by vitest.config.*)",
		]);
	});

	it("blocks the decision, on a warn gate, and no override clears it", () => {
		const fs = run({ ...base, "vitest.config.ts": "v2" });
		const d = decide(
			fs,
			[{ gate: "qa", policy: "warn" }],
			[override("checkpoint:protected:vitest.config.ts")],
			config,
		);
		expect(d.verdict).toBe("block");
		expect(d.ignoredOverrides[0]?.why).toBe("not_overridable");
	});

	it("is an error with no protected paths, or a glob it cannot read", () => {
		for (const protectedPaths of [[], ["{a,b}.json"], ["ok/**", "/abs"]]) {
			expect(outcomes(run(base, { protectedPaths }))).toEqual([
				"checkpoint:protected:error",
			]);
		}
	});

	describe("package.json scripts", () => {
		const scripts = { test: "vitest run", lint: "biome check ." };

		it("is an error when head has a package.json and its scripts are not given", () => {
			const fs = run(base, { packageJsonScripts: undefined });
			expect(outcomes(fs)).toEqual(["checkpoint:protected:error"]);
			expect(fs[0]?.subject).toContain("package.json");
		});

		it("needs no scripts when head has no package.json", () => {
			const { "package.json": _, ...head } = base;
			expect(outcomes(run(head, { packageJsonScripts: undefined }))).toEqual([
				"checkpoint:protected:pass",
			]);
		});

		it("fails a script that changed, was added, or was removed, by key", () => {
			const fs = run(base, {
				packageJsonScripts: {
					base: scripts,
					head: { test: "vitest run --passWithNoTests", build: "tsc" },
				},
			});
			expect(outcomes(fs)).toEqual([
				"checkpoint:protected:package.json#scripts.build:fail",
				"checkpoint:protected:package.json#scripts.lint:fail",
				"checkpoint:protected:package.json#scripts.test:fail",
			]);
			expect(fs.map((f) => f.subject)).toEqual([
				"package.json scripts.build: added",
				"package.json scripts.lint: removed",
				"package.json scripts.test: changed",
			]);
		});

		it("ignores other package.json edits, such as a dependency bump", () => {
			const fs = run(
				{ ...base, "package.json": "p2" },
				{ packageJsonScripts: { base: scripts, head: { ...scripts } } },
			);
			expect(outcomes(fs)).toEqual(["checkpoint:protected:pass"]);
		});

		it("reports script and path changes together", () => {
			const fs = run(
				{ ...base, "vitest.config.ts": "v2" },
				{
					packageJsonScripts: {
						base: scripts,
						head: { ...scripts, test: "true" },
					},
				},
			);
			expect(outcomes(fs)).toEqual([
				"checkpoint:protected:package.json#scripts.test:fail",
				"checkpoint:protected:vitest.config.ts:fail",
			]);
		});
	});

	it("lists every glob that protects a path, in one order", () => {
		const head = { ...base, "vitest.config.ts": "v2" };
		const globs = ["vitest.config.*", "**/vitest.config.*", "*.ts"];
		const subject = (protectedPaths: string[]) =>
			run(head, { protectedPaths })[0]?.subject;
		expect(subject(globs)).toBe(
			"vitest.config.ts: changed (protected by **/vitest.config.*, *.ts, vitest.config.*)",
		);
		expect(subject([...globs].reverse())).toBe(subject(globs));
	});

	it("names the dispatch in the subject when one is given, never in the id", () => {
		const fs = run({ ...base, "vitest.config.ts": "v2" }, { dispatchId: "d1" });
		expect(fs[0]?.id).toBe("checkpoint:protected:vitest.config.ts");
		expect(fs[0]?.subject).toContain("dispatch d1");
	});

	it("does not depend on the order of the trees, globs or scripts", () => {
		const head = {
			...base,
			"vitest.config.ts": "v2",
			".github/workflows/x.yml": "x1",
		};
		const reorder = <T>(r: ReturnType<typeof rng>, o: Record<string, T>) =>
			Object.fromEntries(r.shuffle(Object.entries(o)));
		const expected = run(head, {
			packageJsonScripts: {
				base: { a: "1", b: "2" },
				head: { b: "3", c: "4" },
			},
		});
		const r = rng(3);
		for (let i = 0; i < 20; i++) {
			expect(
				protectedPathFindings({
					protectedPaths: r.shuffle([
						".github/workflows/**",
						"vitest.config.*",
					]),
					base: reorder(r, base),
					head: reorder(r, head),
					commitSha: SHA,
					packageJsonScripts: {
						base: reorder(r, { a: "1", b: "2" }),
						head: reorder(r, { b: "3", c: "4" }),
					},
				}),
			).toEqual(expected);
		}
	});
});

describe("DEFAULT_PROTECTED_PATHS", () => {
	it("is readable by the matcher", () => {
		expect(DEFAULT_PROTECTED_PATHS.every(supportedGlob)).toBe(true);
	});

	it("covers the gate's own configuration, at the root and nested", () => {
		const covered = [
			".github/workflows/ci.yml",
			"vitest.config.ts",
			"packages/web/vitest.config.mts",
			"stryker.conf.json",
			"stryker.conf.mjs",
			"playwright.config.ts",
			"apps/e2e/playwright.config.ts",
			"biome.json",
			"tsconfig.json",
			"tsconfig.build.json",
			"packages/api/tsconfig.json",
			".github/actions/setup/action.yml",
			"vitest.workspace.ts",
			"stryker.config.mjs",
			"jest.config.js",
			"packages/web/jest.config.ts",
			"biome.jsonc",
			"eslint.config.js",
			".eslintrc.json",
			"packages/web/.eslintrc.cjs",
		];
		for (const path of covered) {
			expect(
				DEFAULT_PROTECTED_PATHS.some((g) => matchesGlob(path, g)),
				path,
			).toBe(true);
		}
	});

	it("leaves source, tests, package.json, lockfiles, hooks and repo scripts alone", () => {
		for (const path of [
			"src/a.ts",
			"tests/unit/a.test.ts",
			"package.json",
			".github/CODEOWNERS",
			"pnpm-lock.yaml",
			"package-lock.json",
			".husky/pre-commit",
			"scripts/check-docs.sh",
		]) {
			expect(
				DEFAULT_PROTECTED_PATHS.some((g) => matchesGlob(path, g)),
				path,
			).toBe(false);
		}
	});

	it("over-matches any name after the config stem, which blocks rather than lets through", () => {
		// * inside a segment crosses dots (src/rooms/globs.ts).
		expect(
			DEFAULT_PROTECTED_PATHS.some((g) =>
				matchesGlob("docs/vitest.config.md.txt", g),
			),
		).toBe(true);
	});
});
