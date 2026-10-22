import { describe, expect, it } from "vitest";
import { decide, type GateFinding } from "../../../src/lib/gate";
import {
	DEPENDENCIES_SOURCE,
	dependencyFindings,
	isEnvFile,
	REGISTRY_SOURCE,
	SECRET_RULES,
	SECRET_SCAN_MAX_BYTES,
	SECRET_SCAN_SOURCE,
	secretScanFindings,
} from "../../../src/lib/gate/producers";
import { config, SHA } from "./fixtures";

const outcomes = (fs: GateFinding[]) =>
	fs.map((f) => `${f.id}:${"outcome" in f ? f.outcome : f.kind}`);

const text = (s: string) => new TextEncoder().encode(s);

/**
 * Credentials in each rule's shape, built at run time so this file holds no
 * literal that a push-protection scanner would read as a leaked key.
 */
const FAKE: Record<string, string> = {
	"private-key": `-----BEGIN ${"RSA "}PRIVATE KEY-----`,
	"aws-access-key-id": `AKI${"A"}${"Q".repeat(16)}`,
	"github-token": `gh${"p_"}${"a1".repeat(18)}`,
	"github-fine-grained-token": `github${"_pat_"}${"b".repeat(82)}`,
	"slack-token": `xox${"b-"}${"1".repeat(12)}`,
	"stripe-live-key": `sk${"_live_"}${"c".repeat(24)}`,
	"google-api-key": `AI${"za"}${"d".repeat(35)}`,
	"anthropic-api-key": `sk-${"ant-"}${"e".repeat(40)}`,
	"openai-api-key": `sk-${"proj-"}${"f".repeat(40)}`,
};

describe("secretScanFindings", () => {
	it("has a fake for every rule, and each fake fails on its own rule only", () => {
		expect(Object.keys(FAKE).sort()).toEqual(
			SECRET_RULES.map((r) => r.id).sort(),
		);
		for (const rule of SECRET_RULES) {
			const fs = secretScanFindings(
				[
					{
						path: "src/x.ts",
						content: text(`const k = "${FAKE[rule.id]}";\n`),
					},
				],
				SHA,
			);
			expect(outcomes(fs)).toEqual([`check:secret:src/x.ts:1:${rule.id}:fail`]);
		}
	});

	it("is one pass when nothing matches, on the security gate", () => {
		const fs = secretScanFindings(
			[
				{ path: "src/b.ts", content: text("export const b = 2;\n") },
				{
					path: "src/a.ts",
					content: text('const hash = "9f86d081884c7d65";\n'),
				},
			],
			SHA,
		);
		expect(fs).toEqual([
			{
				gate: "security",
				kind: "check",
				source: SECRET_SCAN_SOURCE,
				commitSha: SHA,
				id: "check:secret",
				subject: "No secret in the 2 text files the work added or changed",
				outcome: "pass",
			},
		]);
	});

	it("names the line, and never carries the secret into the subject", () => {
		const key = FAKE["github-token"] as string;
		const fs = secretScanFindings(
			[{ path: "src/x.ts", content: text(`a\nb\nconst t = "${key}";\n`) }],
			SHA,
		);
		expect(fs).toHaveLength(1);
		expect(fs[0]?.subject).toBe("src/x.ts:3: matches github-token");
		expect(JSON.stringify(fs)).not.toContain(key);
	});

	it("fails a committed .env whatever it holds, and passes the templates", () => {
		expect(
			[".env", "apps/web/.env", ".env.local", ".env.production"].every(
				isEnvFile,
			),
		).toBe(true);
		expect(
			[
				".env.example",
				"a/.env.sample",
				".env.template",
				"env.ts",
				".envrc",
			].some(isEnvFile),
		).toBe(false);
		const fs = secretScanFindings(
			[
				{ path: ".env.local", content: text("PORT=3000\n") },
				{ path: ".env.example", content: text("API_KEY=\n") },
			],
			SHA,
		);
		expect(outcomes(fs)).toEqual(["check:secret:.env.local:env-file:fail"]);
	});

	it("skips a binary file by name, and is an error for a text file too large to scan", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
		expect(
			secretScanFindings([{ path: "a.png", content: png }], SHA)[0]?.subject,
		).toBe(
			"No secret in the 0 text files the work added or changed; binary, not scanned: a.png",
		);
		const big = text("x".repeat(SECRET_SCAN_MAX_BYTES + 1));
		expect(
			outcomes(secretScanFindings([{ path: "big.txt", content: big }], SHA)),
		).toEqual(["check:secret:big.txt:too-large:error"]);
	});

	it("does not depend on the order of its input", () => {
		const files = [
			{ path: "b.ts", content: text(FAKE["aws-access-key-id"] as string) },
			{ path: "a.ts", content: text(FAKE["slack-token"] as string) },
		];
		expect(secretScanFindings(files, SHA)).toEqual(
			secretScanFindings([...files].reverse(), SHA),
		);
	});

	it("blocks the run when security is mandatory, and keeps a warn gate from verified", () => {
		const fs = secretScanFindings(
			[{ path: "s.ts", content: text(FAKE["private-key"] as string) }],
			SHA,
		);
		const cfg = { ...config, availableSources: [SECRET_SCAN_SOURCE] };
		expect(
			decide(fs, [{ gate: "security", policy: "mandatory" }], [], cfg).result,
		).toBe("fail");
		expect(
			decide(fs, [{ gate: "security", policy: "warn" }], [], cfg).result,
		).toBe("pass");
		const clean = secretScanFindings(
			[{ path: "s.ts", content: text("ok") }],
			SHA,
		);
		expect(
			decide(clean, [{ gate: "security", policy: "warn" }], [], cfg).result,
		).toBe("verified");
	});
});

describe("dependencyFindings", () => {
	const pkg = (deps: Record<string, unknown>, extra: object = {}) => ({
		name: "x",
		dependencies: deps,
		...extra,
	});

	it("is one pass when no dependency was added or changed", () => {
		const fs = dependencyFindings(
			[
				{
					path: "package.json",
					base: pkg({ zod: "^4.0.0" }),
					head: { ...pkg({ zod: "^4.0.0" }), scripts: { x: "y" } },
				},
			],
			SHA,
		);
		expect(fs).toEqual([
			{
				gate: "security",
				kind: "check",
				source: DEPENDENCIES_SOURCE,
				commitSha: SHA,
				id: "check:dependency",
				subject: "No dependency added or changed in 1 package.json files",
				outcome: "pass",
			},
		]);
	});

	it("leaves each added or changed registry dependency to the registry check, not run", () => {
		const fs = dependencyFindings(
			[
				{
					path: "package.json",
					base: pkg({ zod: "^3.0.0", hono: "^4.0.0" }),
					head: pkg(
						{ zod: "^4.0.0", hono: "^4.0.0", "@scope/a": "latest" },
						{
							devDependencies: { b: "npm:c@^1" },
							pnpm: { overrides: { "d@<2": "2.1.0" } },
						},
					),
				},
			],
			SHA,
		);
		expect(outcomes(fs)).toEqual([
			"check:dependency:package.json#dependencies.@scope/a:not_run",
			"check:dependency:package.json#dependencies.zod:not_run",
			"check:dependency:package.json#devDependencies.b:not_run",
			"check:dependency:package.json#pnpm.overrides.d@<2:not_run",
		]);
		expect(fs.every((f) => f.source === REGISTRY_SOURCE)).toBe(true);
	});

	it("fails a specifier the registry does not pin, and an invalid name", () => {
		const specs = {
			a: "github:owner/repo",
			b: "git+https://example.com/b.git",
			c: "https://example.com/c.tgz",
			d: "file:../d",
			e: "link:../e",
			f: "owner/repo",
			Upper: "1.0.0",
			g: "npm:Bad@1",
		};
		const fs = dependencyFindings(
			[{ path: "apps/web/package.json", base: undefined, head: pkg(specs) }],
			SHA,
		);
		expect(fs.map((f) => "outcome" in f && f.outcome)).toEqual(
			Object.keys(specs).map(() => "fail"),
		);
		expect(fs.every((f) => f.source === DEPENDENCIES_SOURCE)).toBe(true);
	});

	it("passes workspace and catalog specifiers outright", () => {
		const fs = dependencyFindings(
			[
				{
					path: "package.json",
					base: {},
					head: pkg({ a: "workspace:*", b: "catalog:" }),
				},
			],
			SHA,
		);
		expect(outcomes(fs)).toEqual([
			"check:dependency:package.json#dependencies.a:pass",
			"check:dependency:package.json#dependencies.b:pass",
		]);
	});

	it("is an error for a head package.json that does not parse, or a section it cannot read", () => {
		expect(
			outcomes(
				dependencyFindings(
					[{ path: "package.json", base: {}, head: undefined }],
					SHA,
				),
			),
		).toEqual(["check:dependency:package.json:error"]);
		expect(
			outcomes(
				dependencyFindings(
					[{ path: "package.json", base: {}, head: { dependencies: "zod" } }],
					SHA,
				),
			),
		).toEqual(["check:dependency:package.json#dependencies.*:error"]);
	});
});
