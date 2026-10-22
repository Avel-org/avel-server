import { describe, expect, it } from "vitest";
import { buildSeed, seedIds } from "../../src/db/seed/data";
import { GATE_CONFIG } from "../../src/lib/gate/config";
import {
	BRIEF_CHECKS_GATE,
	PROTECTED_PATHS_GATE,
	SPEC_CHECK_GATE,
	TEST_GLOB_GATE,
} from "../../src/lib/gate/producers";
import { SEED_RUN_AT } from "./seed-run-at";

// A listed gate that nothing feeds has no evidence on any run. Mandatory, it
// blocks every run and no override clears it; warn, it keeps every run from
// verified, which is the only result that ships (J, 2026-10-21).
const FED = new Set<string>([
	BRIEF_CHECKS_GATE,
	PROTECTED_PATHS_GATE,
	SPEC_CHECK_GATE,
	TEST_GLOB_GATE,
	GATE_CONFIG.judgeCoverageGate,
]);

describe("seed playbooks", () => {
	const rows = buildSeed(seedIds(), SEED_RUN_AT);

	it("list only the gates some producer feeds, mandatory or warn", () => {
		const unfed = rows.playbook.flatMap((p) =>
			(p.gates ?? [])
				.filter((g) => !FED.has(g.gate))
				.map((g) => `${p.missionType}:${g.gate}`),
		);
		expect(unfed).toEqual([]);
	});

	it("list the gate the spec check reports on", () => {
		const booking = rows.playbook.find(
			(p) => p.missionType === "template-booking",
		);
		expect(booking?.gates?.map((g) => g.gate)).toContain(SPEC_CHECK_GATE);
	});
});
