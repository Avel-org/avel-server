import { describe, expect, it } from "vitest";
import { boundarySchema, conventionSetSchema } from "../../src/contract";
import {
	DOMINANCE,
	fileCase,
	lowConfidenceIssues,
	majority,
} from "../../src/lib/repo-read/conventions";
import { importGraph } from "../../src/lib/repo-read/imports";
import { readRepo } from "../../src/lib/repo-read/index";
import type { Snapshot } from "../../src/lib/repo-read/snapshot";
import { fixture } from "./repo-fixtures";

function snap(paths: Record<string, string>, commitSha = "c0ffee"): Snapshot {
	return {
		commitSha,
		entries: Object.entries(paths).map(([path, text]) => ({
			path,
			size: text.length,
			text,
		})),
	};
}

describe("the cut", () => {
	it("is vertical for a feature-organised tree, naming the features", () => {
		const read = readRepo(fixture("nest-feature"));
		expect(read.cut).toBe("vertical");
		expect(read.cutEvidence).toBe(
			"commit 6e6573742d666561747572650000000000000000: feature-organised. src/modules/ holds 3 features (bookings/, services/, users/), each with two or more layers, so one agent per feature.",
		);
	});

	it("is horizontal for a layer-organised tree, naming the layers", () => {
		const read = readRepo(fixture("express-layer"));
		expect(read.cut).toBe("horizontal");
		expect(read.cutEvidence).toBe(
			"commit 657870726573732d6c6179657200000000000000: layer-organised. src/ holds layer directories (controllers/, models/, routes/, services/), so one agent per layer.",
		);
	});

	it("is null when the tree holds both, and says so", () => {
		const read = readRepo(fixture("mixed-cut"));
		expect(read.cut).toBeNull();
		expect(read.cutEvidence).toContain(": both.");
		expect(read.boundaries).toEqual([]);
	});

	it("is null for a monorepo of several packages: the scalar cut cannot describe it", () => {
		const read = readRepo(fixture("monorepo"));
		expect(read.cut).toBeNull();
		expect(read.cutEvidence).toContain(
			"packages/ holds 2 packages with their own src/ (api/, web/)",
		);
	});

	it("is null when the tree holds neither", () => {
		const read = readRepo(
			snap({ "src/index.ts": "", "src/util/strings.ts": "" }),
		);
		expect(read.cut).toBeNull();
		expect(read.cutEvidence).toBe(
			"commit c0ffee: neither. src/ holds util/: no feature container with two or more layered features, and fewer than two layer directories, so no cut is derived.",
		);
	});

	it("needs two features with two layers each before it says vertical", () => {
		const one = snap({
			"src/modules/a/a.controller.ts": "",
			"src/modules/a/a.service.ts": "",
			"src/modules/b/b.controller.ts": "",
		});
		expect(readRepo(one).cut).toBeNull();
		const two = snap({
			...Object.fromEntries(one.entries.map((e) => [e.path, ""])),
			"src/modules/b/repositories/b.ts": "",
		});
		expect(readRepo(two).cut).toBe("vertical");
	});

	it("reads the repository root when there is no src/, app/ or lib/", () => {
		const read = readRepo(
			snap({ "handlers/a.go": "", "models/b.go": "", "main.go": "" }),
		);
		expect(read.cut).toBe("horizontal");
		expect(read.cutEvidence).toContain(
			"the repository root holds layer directories (handlers/, models/)",
		);
	});
});

describe("the boundaries", () => {
	it("are the features, with counts and the shared surface they collide on", () => {
		const { boundaries } = readRepo(fixture("nest-feature"));
		expect(boundaries.map((b) => boundarySchema.parse(b))).toEqual([
			{
				kind: "feature",
				path: "src/modules/bookings",
				files: 6,
				loc: 41,
				suggestedTerritory: "bookings",
				collidesWith: ["src/app.module.ts", "src/shared/database.ts"],
			},
			{
				kind: "feature",
				path: "src/modules/services",
				files: 4,
				loc: 21,
				suggestedTerritory: "services",
				collidesWith: ["src/app.module.ts"],
			},
			{
				kind: "feature",
				path: "src/modules/users",
				files: 4,
				loc: 21,
				suggestedTerritory: "users",
				collidesWith: ["src/app.module.ts", "src/shared/database.ts"],
			},
		]);
	});

	it("are the layers for a horizontal cut; a file only one layer touches is no collision", () => {
		const { boundaries } = readRepo(fixture("express-layer"));
		expect(boundaries.map((b) => [b.kind, b.path, b.collidesWith])).toEqual([
			["layer", "src/controllers", []],
			["layer", "src/models", ["src/db.ts"]],
			["layer", "src/routes", []],
			["layer", "src/services", ["src/db.ts"]],
		]);
	});

	it("calls a file a collision only when two boundaries touch it", () => {
		const { boundaries } = readRepo(
			snap({
				"src/controllers/a.ts": `import { u } from "../util";\nimport { s } from "../shared";`,
				"src/services/b.ts": `import { s } from "../shared";`,
				"src/util.ts": "export const u = 1;",
				"src/shared.ts": "export const s = 1;",
			}),
		);
		expect(boundaries.map((b) => [b.path, b.collidesWith])).toEqual([
			["src/controllers", ["src/shared.ts"]],
			["src/services", ["src/shared.ts"]],
		]);
	});

	it("counts lines for text and size / 40 for the rest", () => {
		const s: Snapshot = {
			commitSha: "c",
			entries: [
				{ path: "src/controllers/a.ts", size: 6, text: "a\nb\nc\n" },
				{ path: "src/controllers/logo.png", size: 81 },
				{ path: "src/services/b.ts", size: 1, text: "x" },
			],
		};
		const [controllers, services] = readRepo(s).boundaries;
		expect(controllers?.loc).toBe(3 + 3);
		expect(services?.loc).toBe(1);
	});
});

describe("the conventions", () => {
	it("extracts every entry, with its evidence, from a well-configured tree", () => {
		const { conventions } = readRepo(fixture("nest-feature"));
		expect(conventionSetSchema.parse(conventions)).toEqual(conventions);
		expect(conventions).toMatchObject({
			confidence: "high",
			unextracted: [],
			enforcement: {
				eslint: [".eslintrc.json"],
				tsconfig: ["tsconfig.json"],
				precommit: [".husky/pre-commit"],
				ci: [".github/workflows/ci.yml"],
			},
			layering: {
				pattern:
					"one directory per feature under src/modules/, each holding its own layers",
				confidence: "high",
			},
			testing: {
				runner: "jest",
				location: "colocated",
				naming: ".spec",
				evidence: [
					"package.json",
					"src/modules/bookings/bookings.controller.spec.ts",
					"src/modules/services/services.service.spec.ts",
					"src/modules/users/users.service.spec.ts",
				],
			},
			naming: { files: "kebab", exports: "named" },
			imports: {
				rules: ["no-restricted-imports"],
				evidence: [".eslintrc.json"],
			},
			formatting: { tool: "prettier", configPath: ".prettierrc" },
		});
	});

	it("lists what the tree gives no evidence for, and never guesses it", () => {
		const { conventions } = readRepo(fixture("bare-layer"));
		expect(conventions.unextracted).toEqual([
			"testing",
			"naming",
			"imports",
			"formatting",
		]);
		expect(conventions.testing).toBeUndefined();
		expect(conventions.formatting).toBeUndefined();
		expect(conventions.confidence).toBe("high");
	});

	it("leaves layering out when there is no cut", () => {
		const { conventions } = readRepo(fixture("mixed-cut"));
		expect(conventions.layering).toBeUndefined();
		expect(conventions.unextracted).toContain("layering");
	});

	it("is low when patterns compete, saying exactly what disagreed", () => {
		const { conventions } = readRepo(fixture("competing-tests"));
		expect(conventions.confidence).toBe("low");
		expect(conventions.testing).toMatchObject({
			naming: null,
			confidence: "low",
			disagreements: ["naming: 6 .spec (60%), 4 .test (40%)"],
		});
		expect(conventions.formatting).toMatchObject({
			confidence: "low",
			disagreements: ["tools: prettier (.prettierrc), biome (biome.json)"],
		});
		expect(lowConfidenceIssues(conventions)).toEqual([
			{
				path: ["derivedConventions", "testing"],
				message: "testing: naming: 6 .spec (60%), 4 .test (40%)",
			},
			{
				path: ["derivedConventions", "formatting"],
				message:
					"formatting: tools: prettier (.prettierrc), biome (biome.json)",
			},
		]);
	});

	it("has no issues when every entry is high", () => {
		expect(
			lowConfidenceIssues(readRepo(fixture("nest-feature")).conventions),
		).toEqual([]);
	});

	it("is the same result whatever order the entries arrive in", () => {
		const s = fixture("nest-feature");
		const reversed = { ...s, entries: [...s.entries].reverse() };
		expect(readRepo(reversed)).toEqual(readRepo(s));
	});
});

describe("majority", () => {
	const counts = (o: Record<string, number>) => new Map(Object.entries(o));

	it("takes the dominant value at exactly the threshold", () => {
		expect(DOMINANCE).toBe(0.8);
		expect(majority("naming", counts({ ".spec": 4, ".test": 1 }))).toEqual({
			value: ".spec",
			disagreement: null,
		});
	});

	it("refuses just under the threshold, ordering by count then value", () => {
		expect(majority("naming", counts({ ".test": 21, ".spec": 79 }))).toEqual({
			value: null,
			disagreement: "naming: 79 .spec (79%), 21 .test (21%)",
		});
		expect(majority("x", counts({ b: 1, a: 1 })).disagreement).toBe(
			"x: 1 a (50%), 1 b (50%)",
		);
	});

	it("has no value and no disagreement with no samples", () => {
		expect(majority("x", new Map())).toEqual({
			value: null,
			disagreement: null,
		});
	});
});

describe("fileCase", () => {
	it("reads the stem's case, and gives one lowercase word none", () => {
		expect(fileCase("src/create-booking.dto.ts")).toBe("kebab");
		expect(fileCase("src/create_booking.py")).toBe("snake");
		expect(fileCase("src/createBooking.ts")).toBe("camel");
		expect(fileCase("src/BookingForm.tsx")).toBe("pascal");
		expect(fileCase("src/bookings.controller.ts")).toBeNull();
	});
});

describe("importGraph", () => {
	it("resolves relative specifiers as TypeScript does, and drops packages", () => {
		const graph = importGraph(
			snap({
				"src/a.ts": `import { b } from "./b.js";\nimport x from "express";\nexport * from "./c";\nconst d = require("../outside");\nawait import("./lib");`,
				"src/b.ts": "",
				"src/c/index.ts": "",
				"src/lib/index.tsx": "",
			}),
		);
		expect(graph.get("src/a.ts")).toEqual([
			"src/b.ts",
			"src/c/index.ts",
			"src/lib/index.tsx",
		]);
	});
});
