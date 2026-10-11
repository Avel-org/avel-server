import { describe, expect, it } from "vitest";
import {
	errorEnvelope,
	PRECONDITION_REASONS,
	preconditionDetails,
	validationDetails,
} from "../../src/contract";
import { ApiError } from "../../src/middleware/errors";

// The @ts-expect-error lines are the test: `pnpm typecheck` fails if any of
// them stops being a type error, so a thrower can never pass details that
// do not match its code's schema.
describe("ApiError details are typed by code", () => {
	it("accepts details that match the code's schema", () => {
		const ok = [
			new ApiError("PRECONDITION_FAILED", "x", {
				details: {
					reason: "client_closed",
					clientId: "00000000-0000-4000-8000-000000000001",
				},
			}),
			new ApiError("VALIDATION_FAILED", "x", {
				details: { query: [{ path: ["cursor"], message: "Invalid cursor" }] },
			}),
			new ApiError("VALIDATION_FAILED", "x"),
			new ApiError("PREVIEW_STALE", "x", { details: { anything: true } }),
			new ApiError("NOT_FOUND", "x"),
		];
		expect(ok).toHaveLength(5);
	});

	it("refuses mismatched details at compile time", () => {
		const refused = [
			new ApiError("PRECONDITION_FAILED", "x", {
				// @ts-expect-error a reason outside the closed union
				details: { reason: "client_vanished" },
			}),
			// @ts-expect-error PRECONDITION_FAILED requires details
			new ApiError("PRECONDITION_FAILED", "x"),
			// @ts-expect-error PRECONDITION_FAILED requires a reason
			new ApiError("PRECONDITION_FAILED", "x", { details: { clientId: "c" } }),
			// @ts-expect-error VALIDATION_FAILED issues are an array under a request part
			new ApiError("VALIDATION_FAILED", "x", { details: { cursor: "bad" } }),
			new ApiError("VALIDATION_FAILED", "x", {
				// @ts-expect-error a validation issue needs a message
				details: { body: [{ path: [] }] },
			}),
		];
		expect(refused).toHaveLength(5);
	});
});

describe("the error envelope is a discriminated union on code", () => {
	const envelope = (error: Record<string, unknown>) => ({
		success: false,
		error: { message: "m", requestId: "r", ...error },
	});

	it("lists the closed precondition reasons", () => {
		expect(PRECONDITION_REASONS).toEqual([
			"client_not_found",
			"client_closed",
			"client_has_active_engagements",
			"engagement_not_found",
			"engagement_closed",
			"intake_check_failed",
			"intake_cut_not_derived",
			"skill_source_not_found",
			"skill_source_in_use",
			"skill_capability_mismatch",
			"mission_not_editable",
			"agent_template_not_found",
			"template_not_rosterable",
			"preset_not_found",
			"roster_not_empty",
			"skill_not_found",
			"skill_not_attachable",
			"intake_repo_mismatch",
			"intake_conventions_low_confidence",
			"connection_not_found",
			"connection_expired",
			"connection_scope_mismatch",
			"connection_credential_missing",
			"plan_changes_approved_brief",
			"preset_misses_first_wave",
			"playbook_in_use",
		]);
	});

	it("requires a known reason on PRECONDITION_FAILED, and refuses extra keys", () => {
		expect(
			errorEnvelope.safeParse(
				envelope({
					code: "PRECONDITION_FAILED",
					details: { reason: "client_closed" },
				}),
			).success,
		).toBe(true);
		for (const details of [
			undefined,
			{ reason: "nope" },
			{ reason: "client_closed", extra: 1 },
		]) {
			expect(
				errorEnvelope.safeParse(
					envelope({ code: "PRECONDITION_FAILED", details }),
				).success,
				JSON.stringify(details),
			).toBe(false);
		}
	});

	it("carries an optional engagementId and check issues on PRECONDITION_FAILED", () => {
		const details = {
			reason: "intake_check_failed",
			engagementId: "00000000-0000-4000-8000-000000000001",
			issues: [{ path: ["proposedBrief", "requirements", 0], message: "m" }],
		};
		expect(preconditionDetails.safeParse(details).success).toBe(true);
		for (const bad of [
			{ ...details, engagementId: "nope" },
			{ ...details, issues: [{ path: [], message: "m", extra: 1 }] },
			{ ...details, issues: [{ path: [true], message: "m" }] },
		]) {
			expect(preconditionDetails.safeParse(bad).success).toBe(false);
		}
	});

	it("types VALIDATION_FAILED issues by request part, with details optional", () => {
		expect(
			errorEnvelope.safeParse(envelope({ code: "VALIDATION_FAILED" })).success,
		).toBe(true);
		expect(
			errorEnvelope.safeParse(
				envelope({
					code: "VALIDATION_FAILED",
					details: {
						body: [
							{ path: ["name"], message: "Required", code: "invalid_type" },
						],
					},
				}),
			).success,
		).toBe(true);
		expect(
			errorEnvelope.safeParse(
				envelope({ code: "VALIDATION_FAILED", details: { cursor: [] } }),
			).success,
		).toBe(false);
	});

	it("keeps details open for codes without a schema", () => {
		expect(
			errorEnvelope.safeParse(
				envelope({ code: "PREVIEW_STALE", details: { from: "a", to: "b" } }),
			).success,
		).toBe(true);
		expect(
			errorEnvelope.safeParse(envelope({ code: "NOT_A_CODE" })).success,
		).toBe(false);
	});

	it("exports each detail schema for clients", () => {
		expect(
			preconditionDetails.safeParse({ reason: "client_not_found" }).success,
		).toBe(true);
		expect(validationDetails.safeParse({ params: [] }).success).toBe(true);
	});
});
