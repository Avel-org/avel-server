import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type GateReasonWire,
	gateReason,
	DECIDE_RULES as WIRE_RULES,
} from "../../../src/contract/gate";
import { DECIDE_RULES, decide, type GateReason } from "../../../src/lib/gate";
import { check, config, finding } from "./fixtures";

// Type-level: pnpm typecheck fails when the wire gains a field the lib
// lacks, or the lib adds one the wire does not carry.
const toWire = (r: GateReason): GateReasonWire => r;
const fromWire = (r: GateReasonWire): GateReason => r;

describe("the gate wire", () => {
	it("has the same reason type as decide()", () => {
		expectTypeOf<GateReason>().toEqualTypeOf<GateReasonWire>();
		expect([toWire, fromWire]).toHaveLength(2);
	});

	it("uses the contract's rule list, not a copy", () => {
		expect(DECIDE_RULES).toBe(WIRE_RULES);
	});

	it("parses every reason decide() writes", () => {
		const d = decide(
			[
				check("t1", "qa", "fail"),
				finding("checkpoint", { id: "cp", gate: "security", outcome: "fail" }),
				finding("judge", {
					id: "j1",
					gate: "qa",
					status: "open",
					severity: "high",
					operatorSeverity: "low",
				}),
			],
			[
				{ gate: "qa", policy: "mandatory" },
				{ gate: "acceptance", policy: "warn" },
			],
			[],
			config,
		);
		for (const r of d.reasons) {
			expect(gateReason.strict().parse(r)).toEqual(r);
		}
	});
});
