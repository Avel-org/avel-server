import { describe, expect, it } from "vitest";
import {
	checkDeliverable,
	checkDeterminism,
	checkGateVerified,
	checkNoViolations,
	checkPreviewFresh,
	checkPreviewMatchesMission,
	checkPreviewRequired,
	type DeliverableInput,
	type GuardResult,
} from "../../src/lib/export/delivery";

const MISSION = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PREVIEW = "00000000-0000-4000-8000-000000000003";
const BASE = "a".repeat(40);
const MOVED = "b".repeat(40);
const PKG = "c".repeat(64);

function reason(r: GuardResult): string {
	return r.ok ? "ok" : r.reason;
}

describe("guard signatures", () => {
	it("checkNoViolations takes one argument: no override", () => {
		expect(checkNoViolations.length).toBe(1);
	});
	it("checkPreviewFresh takes two shas and nothing else", () => {
		expect(checkPreviewFresh.length).toBe(2);
	});
	it("checkGateVerified takes only the result", () => {
		expect(checkGateVerified.length).toBe(1);
	});
});

describe("guard parameter lists", () => {
	// length does not count a parameter with a default, so the source is read too.
	const params = (f: (...args: never[]) => unknown) =>
		/^function\s*\w*\s*\(([^)]*)\)/.exec(f.toString())?.[1]?.replace(/\s/g, "");
	it("checkNoViolations declares only violations", () => {
		expect(params(checkNoViolations)).toBe("violations");
	});
	it("checkPreviewFresh declares only the two shas", () => {
		expect(params(checkPreviewFresh)).toBe("previewBaseSha,currentBaseSha");
	});
	it("checkGateVerified declares only the result", () => {
		expect(params(checkGateVerified)).toBe("result");
	});
});

describe("checkGateVerified", () => {
	it("allows verified", () => {
		expect(checkGateVerified("verified")).toEqual({ ok: true, warnings: [] });
	});
	it("refuses pass and fail with distinct reasons", () => {
		const pass = checkGateVerified("pass");
		const fail = checkGateVerified("fail");
		expect(reason(pass)).toBe("gate_pass_not_verified");
		expect(reason(fail)).toBe("gate_failed");
		expect(pass.ok || pass.code).toBe("PRECONDITION_FAILED");
	});
});

describe("checkNoViolations", () => {
	it("allows none", () => {
		expect(checkNoViolations([]).ok).toBe(true);
	});
	it("refuses one, and carries it", () => {
		const v = { code: "PATH_TRAVERSAL" as const, path: "../x", detail: "d" };
		const r = checkNoViolations([v]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.code).toBe("BLAST_RADIUS_VIOLATION");
		expect(r.details).toEqual({ violations: [v] });
	});
});

describe("checkPreviewRequired", () => {
	it("refuses github_push without a preview", () => {
		const r = checkPreviewRequired("github_push", null);
		expect(reason(r)).toBe("preview_required");
		expect(r.ok || r.code).toBe("PREVIEW_REQUIRED");
	});
	it("allows github_pr without a preview, warned", () => {
		expect(checkPreviewRequired("github_pr", null)).toEqual({
			ok: true,
			warnings: ["preview_absent"],
		});
	});
	it("does not require one for zip", () => {
		expect(checkPreviewRequired("zip", null)).toEqual({
			ok: true,
			warnings: [],
		});
	});
	it("allows every target with a preview, unwarned", () => {
		for (const t of ["zip", "github_pr", "github_push"] as const) {
			expect(checkPreviewRequired(t, PREVIEW)).toEqual({
				ok: true,
				warnings: [],
			});
		}
	});
});

describe("checkPreviewMatchesMission", () => {
	it("allows the same mission and refuses another", () => {
		expect(checkPreviewMatchesMission(MISSION, MISSION).ok).toBe(true);
		expect(reason(checkPreviewMatchesMission(OTHER, MISSION))).toBe(
			"preview_mission_mismatch",
		);
	});
});

describe("checkPreviewFresh", () => {
	it("allows an unmoved tip, including an empty repository", () => {
		expect(checkPreviewFresh(BASE, BASE).ok).toBe(true);
		expect(checkPreviewFresh(null, null).ok).toBe(true);
	});
	it("refuses a moved tip with both shas", () => {
		const r = checkPreviewFresh(BASE, MOVED);
		expect(reason(r)).toBe("preview_stale");
		if (r.ok) return;
		expect(r.code).toBe("PREVIEW_STALE");
		expect(r.details).toEqual({ previewBaseSha: BASE, currentBaseSha: MOVED });
	});
	it("refuses an empty repository that gained a commit", () => {
		expect(reason(checkPreviewFresh(null, BASE))).toBe("preview_stale");
	});
});

describe("checkDeterminism", () => {
	it("allows an equal hash under the same version", () => {
		expect(checkDeterminism(PKG, 1, PKG, 1).ok).toBe(true);
	});
	it("refuses a different hash as a determinism violation", () => {
		const r = checkDeterminism(PKG, 1, "d".repeat(64), 1);
		expect(reason(r)).toBe("package_hash_mismatch");
		expect(r.ok || r.code).toBe("DETERMINISM_VIOLATION");
	});
	it("refuses a different version distinctly, even with equal hashes", () => {
		const r = checkDeterminism(PKG, 1, PKG, 2);
		expect(reason(r)).toBe("package_hash_version_mismatch");
		expect(r.ok || r.code).not.toBe("DETERMINISM_VIOLATION");
	});
});

describe("checkDeliverable", () => {
	const good: DeliverableInput = {
		gateResult: "verified",
		violations: [],
		target: "github_push",
		missionId: MISSION,
		preview: {
			exportId: PREVIEW,
			missionId: MISSION,
			baseCommitSha: BASE,
			packageSha: PKG,
			packageHashVersion: 1,
		},
		currentBaseSha: BASE,
		packageSha: PKG,
		packageHashVersion: 1,
	};
	const preview = good.preview as NonNullable<DeliverableInput["preview"]>;

	it("allows a verified, clean, fresh, matching delivery", () => {
		expect(checkDeliverable(good)).toEqual({ ok: true, warnings: [] });
	});

	it("refuses each defect alone", () => {
		const cases: Array<[Partial<DeliverableInput>, string]> = [
			[{ gateResult: "pass" }, "gate_pass_not_verified"],
			[{ gateResult: "fail" }, "gate_failed"],
			[
				{ violations: [{ code: "PATH_TRAVERSAL", path: "..", detail: "d" }] },
				"blast_radius_violation",
			],
			[{ preview: null }, "preview_required"],
			[
				{ preview: { ...preview, missionId: OTHER } },
				"preview_mission_mismatch",
			],
			[{ currentBaseSha: MOVED }, "preview_stale"],
			[{ packageHashVersion: 2 }, "package_hash_version_mismatch"],
			[{ packageSha: "d".repeat(64) }, "package_hash_mismatch"],
		];
		for (const [change, expected] of cases) {
			expect(reason(checkDeliverable({ ...good, ...change }))).toBe(expected);
		}
	});

	it("checks in a fixed order, and the first refusal wins", () => {
		const everything: DeliverableInput = {
			...good,
			gateResult: "fail",
			violations: [{ code: "PATH_TRAVERSAL", path: "..", detail: "d" }],
			preview: { ...preview, missionId: OTHER },
			currentBaseSha: MOVED,
			packageSha: "d".repeat(64),
			packageHashVersion: 2,
		};
		const order = [
			"gate_failed",
			"blast_radius_violation",
			"preview_mission_mismatch",
			"preview_stale",
			"package_hash_version_mismatch",
			"package_hash_mismatch",
		];
		const fixes: Array<Partial<DeliverableInput>> = [
			{ gateResult: "verified" },
			{ violations: [] },
			{ preview },
			{ currentBaseSha: BASE },
			{ packageHashVersion: 1 },
			{ packageSha: PKG },
		];
		let input = everything;
		for (let i = 0; i < order.length; i++) {
			expect(reason(checkDeliverable(input))).toBe(order[i]);
			input = { ...input, ...fixes[i] };
		}
		expect(checkDeliverable(input).ok).toBe(true);
	});

	it("puts preview_required after violations and before the preview's own checks", () => {
		expect(
			reason(
				checkDeliverable({
					...good,
					violations: [{ code: "PATH_TRAVERSAL", path: "..", detail: "d" }],
					preview: null,
				}),
			),
		).toBe("blast_radius_violation");
	});

	it("never delivers a gate pass, to any target", () => {
		for (const target of ["zip", "github_pr", "github_push"] as const) {
			expect(
				reason(checkDeliverable({ ...good, target, gateResult: "pass" })),
			).toBe("gate_pass_not_verified");
		}
	});

	it("allows a github_pr without a preview, warned", () => {
		expect(
			checkDeliverable({ ...good, target: "github_pr", preview: null }),
		).toEqual({ ok: true, warnings: ["preview_absent"] });
	});

	it("allows a zip without a preview, unwarned", () => {
		expect(
			checkDeliverable({
				...good,
				target: "zip",
				preview: null,
				currentBaseSha: null,
			}),
		).toEqual({ ok: true, warnings: [] });
	});
});
