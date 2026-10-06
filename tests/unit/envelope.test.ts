import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	errorCode,
	errorEnvelope,
	fail,
	ok,
	page,
	pageEnvelope,
	pageQuery,
	successEnvelope,
} from "../../src/contract";

describe("errorCode", () => {
	it("accepts a code in the union", () => {
		expect(errorCode.safeParse("PREVIEW_STALE").success).toBe(true);
	});

	it("accepts GITHUB_REJECTED, which is not retryable like EXTERNAL_GITHUB", () => {
		expect(errorCode.safeParse("GITHUB_REJECTED").success).toBe(true);
	});

	it("refuses a code outside the union", () => {
		expect(errorCode.safeParse("NOT_A_CODE").success).toBe(false);
	});
});

describe("error envelope", () => {
	it("fail() builds a body the schema accepts", () => {
		const body = fail("NOT_FOUND", "No such mission", "req-0001");
		expect(body).toEqual({
			success: false,
			error: {
				code: "NOT_FOUND",
				message: "No such mission",
				requestId: "req-0001",
			},
		});
		expect(errorEnvelope.safeParse(body).success).toBe(true);
	});

	it("carries details only when given", () => {
		const body = fail("PREVIEW_STALE", "Tip moved", "req-0002", {
			from: "a",
			to: "b",
		});
		expect(body.error.details).toEqual({ from: "a", to: "b" });
		expect("details" in fail("INTERNAL", "x", "req-0003").error).toBe(false);
	});

	it("refuses an error without a requestId", () => {
		const body = { success: false, error: { code: "INTERNAL", message: "x" } };
		expect(errorEnvelope.safeParse(body).success).toBe(false);
	});
});

describe("success envelope", () => {
	const schema = successEnvelope(z.object({ id: z.string() }));

	it("ok() builds a body the schema accepts, with no meta key when none is given", () => {
		const body = ok({ id: "m-1" });
		expect(body).toEqual({ success: true, data: { id: "m-1" } });
		expect("meta" in body).toBe(false);
		expect(schema.safeParse(body).success).toBe(true);
	});

	it("refuses data that does not match the shape", () => {
		expect(schema.safeParse(ok({ id: 1 })).success).toBe(false);
	});

	it("refuses an error envelope", () => {
		expect(schema.safeParse(fail("INTERNAL", "x", "req-0001")).success).toBe(
			false,
		);
	});
});

describe("pagination", () => {
	it("defaults limit to 50 and coerces it from a query string", () => {
		expect(pageQuery.parse({})).toEqual({ limit: 50 });
		expect(pageQuery.parse({ limit: "10", cursor: "c1" })).toEqual({
			limit: 10,
			cursor: "c1",
		});
	});

	it("refuses a limit outside 1 to 100, and an empty cursor", () => {
		expect(pageQuery.safeParse({ limit: "0" }).success).toBe(false);
		expect(pageQuery.safeParse({ limit: "101" }).success).toBe(false);
		expect(pageQuery.safeParse({ limit: "2.5" }).success).toBe(false);
		expect(pageQuery.safeParse({ cursor: "" }).success).toBe(false);
	});

	it("page() builds a body pageEnvelope accepts, and meta is required", () => {
		const schema = pageEnvelope(z.string());
		expect(schema.safeParse(page(["a", "b"], null)).success).toBe(true);
		expect(schema.safeParse(ok(["a", "b"])).success).toBe(false);
	});
});
