import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../../src/lib/clock";
import { sequentialIds } from "../../src/lib/ids";

describe("fixedClock", () => {
	it("returns the same instant every time", () => {
		const clock = fixedClock("2026-10-03T12:00:00.000Z");
		expect(clock.now().toISOString()).toBe(clock.now().toISOString());
	});

	it("hands out a fresh Date, so a caller mutating it cannot move the clock", () => {
		const clock = fixedClock("2026-10-03T12:00:00.000Z");
		clock.now().setFullYear(1999);
		expect(clock.now().toISOString()).toBe("2026-10-03T12:00:00.000Z");
	});

	it("refuses an invalid timestamp instead of returning Invalid Date", () => {
		expect(() => fixedClock("not a date")).toThrow(/not a valid ISO timestamp/);
	});
});

describe("sequentialIds", () => {
	it("is predictable, so output can be compared exactly", () => {
		const ids = sequentialIds();
		expect([ids.next(), ids.next(), ids.next()]).toEqual([
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
			"00000000-0000-4000-8000-000000000003",
		]);
	});

	// Ids land in uuid primary keys, and the contract validates z.string().uuid().
	// The previous "id-0001" form was rejected by both.
	it("produces values a uuid column and z.string().uuid() accept", () => {
		const ids = sequentialIds();
		for (let i = 0; i < 20; i++) {
			expect(z.string().uuid().safeParse(ids.next()).success).toBe(true);
		}
	});

	it("starts over for each generator, so tests do not share a counter", () => {
		sequentialIds().next();
		expect(sequentialIds().next()).toBe("00000000-0000-4000-8000-000000000001");
	});
});
