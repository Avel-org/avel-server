import { describe, expect, it } from "vitest";
import { readRepo } from "../../src/lib/repo-read/index";
import { detectLanguages } from "../../src/lib/repo-read/languages";
import type { Snapshot } from "../../src/lib/repo-read/snapshot";

const snap = (...paths: string[]): Snapshot => ({
	commitSha: "c0ffee",
	entries: paths.map((path) => ({ path, size: 1 })),
});

describe("detectLanguages", () => {
	it("counts source files by extension and lists manifests, most files first", () => {
		expect(
			detectLanguages(
				snap(
					"package.json",
					"tsconfig.json",
					"src/a.ts",
					"src/b.tsx",
					"src/types.d.ts",
					"scripts/x.mjs",
					"tools/gen.py",
					"tools/requirements-dev.txt",
				),
			),
		).toEqual([
			{ language: "typescript", files: 3, manifests: ["tsconfig.json"] },
			{ language: "javascript", files: 1, manifests: ["package.json"] },
			{
				language: "python",
				files: 1,
				manifests: ["tools/requirements-dev.txt"],
			},
		]);
	});

	it("reads Go, Rust and Elixir manifests at any depth; mix.exs is Elixir source too", () => {
		expect(
			detectLanguages(snap("svc/go.mod", "crates/x/Cargo.toml", "mix.exs")),
		).toEqual([
			{ language: "elixir", files: 1, manifests: ["mix.exs"] },
			{ language: "go", files: 0, manifests: ["svc/go.mod"] },
			{ language: "rust", files: 0, manifests: ["crates/x/Cargo.toml"] },
		]);
	});

	it("breaks a tie by name in byte order, and ignores what it does not know", () => {
		expect(
			detectLanguages(
				snap("b.rb", "a.go", "README.md", "x.constructor", ".ts", "Makefile"),
			).map((l) => [l.language, l.files]),
		).toEqual([
			["go", 1],
			["ruby", 1],
		]);
	});

	it("gives the same list whatever order the tree comes in", () => {
		const paths = ["z/go.mod", "a/main.go", "b/c.py", "pyproject.toml", "a.ts"];
		expect(detectLanguages(snap(...[...paths].reverse()))).toEqual(
			detectLanguages(snap(...paths)),
		);
	});

	it("lists a language's manifests in byte order, whatever order the tree comes in", () => {
		expect(
			detectLanguages(snap("web/package.json", "api/package.json"))[0]
				?.manifests,
		).toEqual(["api/package.json", "web/package.json"]);
	});

	it("is part of the repo read", () => {
		expect(readRepo(snap("go.mod", "main.go")).languages).toEqual([
			{ language: "go", files: 1, manifests: ["go.mod"] },
		]);
	});
});
