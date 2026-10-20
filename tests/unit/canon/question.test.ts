import { describe, expect, it } from "vitest";
import {
	askOperatorInput,
	QUESTION_HEADER_MAX,
	QUESTION_OPTIONS_MAX,
	QUESTION_OPTIONS_MIN,
} from "../../../src/lib/canon";

const SHA = "e".repeat(64);

const valid = {
	header: "Payments",
	question: "Which payment provider should checkout use?",
	options: [
		{ label: "Stripe", description: "Cards and wallets" },
		{ label: "Square", description: "Matches the in-salon terminal" },
	],
	multiSelect: false,
	reason: "The brief names both providers.",
	sourceChunkIds: [`${SHA}:3-9`],
};

const ok = (input: unknown) => askOperatorInput.safeParse(input).success;

describe("askOperatorInput", () => {
	it("exports the bounds the canon_question CHECKs use", () => {
		expect([
			QUESTION_HEADER_MAX,
			QUESTION_OPTIONS_MIN,
			QUESTION_OPTIONS_MAX,
		]).toEqual([12, 2, 4]);
	});

	it("accepts a well-formed question and trims its text", () => {
		const parsed = askOperatorInput.parse({ ...valid, header: "  Payments  " });
		expect(parsed.header).toBe("Payments");
		expect(ok({ ...valid, multiSelect: true, sourceChunkIds: [] })).toBe(true);
	});

	it("bounds the header to 1 to 12 characters after trim, counted as characters", () => {
		expect(ok({ ...valid, header: "123456789012" })).toBe(true);
		expect(ok({ ...valid, header: "  123456789012  " })).toBe(true);
		expect(ok({ ...valid, header: "1234567890123" })).toBe(false);
		expect(ok({ ...valid, header: "   " })).toBe(false);
		// Twelve code points, twenty-four UTF-16 units: Postgres char_length says 12.
		expect(ok({ ...valid, header: "😀".repeat(12) })).toBe(true);
		expect(ok({ ...valid, header: "😀".repeat(13) })).toBe(false);
	});

	it("needs a question and a reason", () => {
		expect(ok({ ...valid, question: " " })).toBe(false);
		expect(ok({ ...valid, reason: "" })).toBe(false);
	});

	it("takes 2 to 4 options with unique, non-empty labels and descriptions", () => {
		const opt = (label: string) => ({ label, description: `About ${label}` });
		expect(ok({ ...valid, options: [opt("A")] })).toBe(false);
		expect(ok({ ...valid, options: ["A", "B", "C", "D"].map(opt) })).toBe(true);
		expect(ok({ ...valid, options: ["A", "B", "C", "D", "E"].map(opt) })).toBe(
			false,
		);
		expect(ok({ ...valid, options: [opt("A"), opt("A")] })).toBe(false);
		expect(ok({ ...valid, options: [opt("A"), opt(" A ")] })).toBe(false);
		expect(ok({ ...valid, options: [opt("A"), opt(" ")] })).toBe(false);
		expect(
			ok({ ...valid, options: [opt("A"), { label: "B", description: "" }] }),
		).toBe(false);
	});

	it("needs multiSelect as a boolean and chunk ids in their own format", () => {
		expect(ok({ ...valid, multiSelect: "no" })).toBe(false);
		expect(ok({ ...valid, sourceChunkIds: ["R1"] })).toBe(false);
		expect(ok({ ...valid, sourceChunkIds: [`${SHA}:9-3`] })).toBe(false);
		expect(ok({ ...valid, sourceChunkIds: [`${SHA}:0-3`] })).toBe(false);
	});

	it("refuses fields it does not know", () => {
		expect(ok({ ...valid, status: "answered" })).toBe(false);
		expect(
			ok({
				...valid,
				options: [{ ...valid.options[0], extra: 1 }, valid.options[1]],
			}),
		).toBe(false);
	});
});
