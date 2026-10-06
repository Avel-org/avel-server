import { RequestValidationError } from "@ts-rest/serverless/fetch";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { contract, ERROR_STATUSES, errorCode } from "../../src/contract";
import {
	ApiError,
	statusFor,
	toErrorEnvelope,
} from "../../src/middleware/errors";

describe("toErrorEnvelope", () => {
	it("maps a ts-rest validation failure to 400 VALIDATION_FAILED with the issues", () => {
		const parsed = z
			.object({ missionId: z.string().uuid() })
			.safeParse({ missionId: "x" });
		if (parsed.success) throw new Error("expected the parse to fail");
		const report = vi.fn();
		const { status, body } = toErrorEnvelope(
			new RequestValidationError(null, null, null, parsed.error),
			"req-0001",
			report,
		);
		expect(status).toBe(400);
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.details).toEqual({
			body: [
				{
					path: ["missionId"],
					message: "Invalid uuid",
					code: "invalid_string",
				},
			],
		});
		expect(report).not.toHaveBeenCalled();
	});

	it("uses an ApiError's code, default status, and details", () => {
		const { status, body } = toErrorEnvelope(
			new ApiError("PREVIEW_STALE", "The branch tip moved", {
				details: { from: "a", to: "b" },
			}),
			"req-0001",
			vi.fn(),
		);
		expect(status).toBe(409);
		expect(body).toEqual({
			success: false,
			error: {
				code: "PREVIEW_STALE",
				message: "The branch tip moved",
				details: { from: "a", to: "b" },
				requestId: "req-0001",
			},
		});
	});

	it("lets an ApiError override its default status", () => {
		const { status } = toErrorEnvelope(
			new ApiError("BRANCH_NOT_FOUND", "x", { status: 422 }),
			"req-0001",
			vi.fn(),
		);
		expect(status).toBe(422);
	});

	it("reports a 5xx ApiError, and does not report a 4xx one", () => {
		const report = vi.fn();
		toErrorEnvelope(new ApiError("NOT_FOUND", "x"), "req-0001", report);
		expect(report).not.toHaveBeenCalled();
		toErrorEnvelope(new ApiError("EXTERNAL_GITHUB", "x"), "req-0002", report);
		expect(report).toHaveBeenCalledTimes(1);
	});

	it("hides anything that is not an ApiError behind INTERNAL", () => {
		const report = vi.fn();
		const { status, body } = toErrorEnvelope(
			"a thrown string",
			"req-0001",
			report,
		);
		expect(status).toBe(500);
		expect(body.error).toEqual({
			code: "INTERNAL",
			message: "Internal server error",
			requestId: "req-0001",
		});
		expect(report).toHaveBeenCalledWith("a thrown string", "req-0001");
	});
});

describe("statusFor", () => {
	it("gives every code in the union an error status", () => {
		for (const code of errorCode.options) {
			expect(statusFor[code]).toBeGreaterThanOrEqual(400);
			expect(statusFor[code]).toBeLessThan(600);
		}
	});

	it("matches the statuses the docs put on route responses", () => {
		expect(statusFor.IDEMPOTENCY_REPLAY).toBe(409);
		expect(statusFor.PREVIEW_STALE).toBe(409);
		expect(statusFor.PRECONDITION_FAILED).toBe(422);
		expect(statusFor.BLAST_RADIUS_VIOLATION).toBe(422);
		expect(statusFor.DETERMINISM_VIOLATION).toBe(422);
		expect(statusFor.PREVIEW_REQUIRED).toBe(422);
		expect(statusFor.REPO_NOT_FOUND).toBe(404);
		expect(statusFor.REPO_NO_ACCESS).toBe(403);
		expect(statusFor.POLICY_FORBIDS_TARGET).toBe(403);
		expect(statusFor.EXTERNAL_GITHUB).toBe(502);
		expect(statusFor.TREE_TOO_LARGE).toBe(502);
		expect(statusFor.GITHUB_REJECTED).toBe(502);
	});
});

describe("ERROR_STATUSES", () => {
	it("declares every status statusFor can emit, so no client sees an undeclared status", () => {
		const declared: readonly number[] = ERROR_STATUSES;
		const emitted = [...new Set(Object.values(statusFor))].sort();
		expect(emitted.filter((s) => !declared.includes(s))).toEqual([]);
	});

	it("is what every route in the contract declares, nested groups included", () => {
		const routes: Array<{ path: string; responses: object }> = [];
		const walk = (node: object) => {
			for (const value of Object.values(node)) {
				if ("method" in value) routes.push(value);
				else walk(value);
			}
		};
		walk(contract);
		expect(routes.length).toBeGreaterThan(9);
		for (const route of routes) {
			for (const status of ERROR_STATUSES) {
				expect(route.responses, `${route.path} ${status}`).toHaveProperty(
					String(status),
				);
			}
		}
	});
});
