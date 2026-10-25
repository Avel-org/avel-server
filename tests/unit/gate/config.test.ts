import { describe, expect, it } from "vitest";
import { GATES } from "../../../src/contract/playbook";
import { GATE_CONFIG } from "../../../src/lib/gate/config";
import {
	DEFAULT_PROTECTED_PATHS,
	DEPENDENCIES_SOURCE,
	FILE_EXISTS_SOURCE,
	JUDGE_COVERAGE_SOURCE,
	PRIOR_FINDING_SOURCE,
	PROTECTED_PATHS_SOURCE,
	REGISTRY_SOURCE,
	RUNNER_SOURCE,
	SECRET_SCAN_SOURCE,
	SPEC_CHECK_SOURCE,
	TEST_GLOB_SOURCE,
} from "../../../src/lib/gate/producers";
import { matchesGlob, supportedGlob } from "../../../src/rooms/globs";

describe("GATE_CONFIG", () => {
	it("is version 3, with coverage on the qa gate", () => {
		// 3: module 12's prior-finding checks (2026-10-24).
		expect(GATE_CONFIG.version).toBe(3);
		expect(GATE_CONFIG.judgeCoverageGate).toBe("qa");
		expect(GATES).toContain(GATE_CONFIG.judgeCoverageGate);
	});

	it("installs every producer's source, and neither the runner nor the registry", () => {
		expect([...GATE_CONFIG.availableSources].sort()).toEqual(
			[
				SPEC_CHECK_SOURCE,
				FILE_EXISTS_SOURCE,
				TEST_GLOB_SOURCE,
				PROTECTED_PATHS_SOURCE,
				JUDGE_COVERAGE_SOURCE,
				SECRET_SCAN_SOURCE,
				DEPENDENCIES_SOURCE,
				PRIOR_FINDING_SOURCE,
			].sort(),
		);
		expect(GATE_CONFIG.availableSources).not.toContain(RUNNER_SOURCE);
		expect(GATE_CONFIG.availableSources).not.toContain(REGISTRY_SOURCE);
	});

	it("protects the default paths", () => {
		expect(GATE_CONFIG.protectedPaths).toEqual(DEFAULT_PROTECTED_PATHS);
	});

	it("reads tests under tests/ and as *.test.ts or *.spec.ts anywhere", () => {
		expect(GATE_CONFIG.testGlobs).toEqual([
			"tests/**",
			"**/*.test.ts",
			"**/*.spec.ts",
		]);
		expect(GATE_CONFIG.testGlobs.every(supportedGlob)).toBe(true);
		const isTest = (p: string) =>
			GATE_CONFIG.testGlobs.some((g) => matchesGlob(p, g));
		for (const p of ["tests/unit/a.ts", "src/a.test.ts", "src/b/c.spec.ts"]) {
			expect(isTest(p), p).toBe(true);
		}
		for (const p of ["src/a.ts", "src/testsx/a.ts", "fixtures/golden/a.json"]) {
			expect(isTest(p), p).toBe(false);
		}
	});

	it("cannot be changed at runtime", () => {
		expect(Object.isFrozen(GATE_CONFIG)).toBe(true);
		expect(Object.isFrozen(GATE_CONFIG.availableSources)).toBe(true);
		expect(Object.isFrozen(GATE_CONFIG.testGlobs)).toBe(true);
		expect(Object.isFrozen(GATE_CONFIG.protectedPaths)).toBe(true);
	});
});
