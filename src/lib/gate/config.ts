import type { Gate } from "../../contract/playbook";
import {
	DEFAULT_PROTECTED_PATHS,
	DEPENDENCIES_SOURCE,
	DEPENDENCY_RULES,
	type DependencyRules,
	FILE_EXISTS_SOURCE,
	JUDGE_COVERAGE_SOURCE,
	PRIOR_FINDING_SOURCE,
	PROTECTED_PATHS_SOURCE,
	SECRET_SCAN_CONFIG,
	SECRET_SCAN_SOURCE,
	type SecretScanConfig,
	SPEC_CHECK_SOURCE,
	TEST_GLOB_SOURCE,
} from "./producers";

export type GateConfig = {
	version: number;
	/** Sources installed here. A not_run from any other degrades to a warn. */
	availableSources: readonly string[];
	testGlobs: readonly string[];
	protectedPaths: readonly string[];
	/** The gate judge coverage reports on. */
	judgeCoverageGate: Gate;
	/** The secret scan's rules, env-template suffixes and size limit. */
	secretScan: SecretScanConfig;
	/** The dependency check's sections and patterns. */
	dependencies: DependencyRules;
};

/**
 * The gate's one configuration: global and versioned, never per mission
 * (CLAUDE.md, settled). It changes only by commit, and the receipt hashes all
 * of it. Bump `version` with any change.
 *
 * No runner is installed, so test, typecheck and command checks are not_run
 * from `runner`. They degrade to warns, and the run lists them as not
 * checked, so it cannot be verified until a runner is installed.
 *
 * Version 2 (2026-10-22) installs the security gate's code-reading checks:
 * the secret scan and the dependency check. Their rules are fields here,
 * so the receipt's config hash changes when one does.
 *
 * Version 3 (2026-10-24) installs module 12's prior-finding checks: each
 * confirmed finding's permanent check, run on what the work changed.
 */
export const GATE_CONFIG: GateConfig = Object.freeze({
	version: 3,
	availableSources: Object.freeze([
		SPEC_CHECK_SOURCE,
		FILE_EXISTS_SOURCE,
		TEST_GLOB_SOURCE,
		PROTECTED_PATHS_SOURCE,
		JUDGE_COVERAGE_SOURCE,
		SECRET_SCAN_SOURCE,
		DEPENDENCIES_SOURCE,
		PRIOR_FINDING_SOURCE,
	]),
	// Templates keep tests in their own directories (SANDBOX.md).
	testGlobs: Object.freeze(["tests/**", "**/*.test.ts", "**/*.spec.ts"]),
	protectedPaths: Object.freeze([...DEFAULT_PROTECTED_PATHS]),
	judgeCoverageGate: "qa",
	secretScan: SECRET_SCAN_CONFIG,
	dependencies: DEPENDENCY_RULES,
});
