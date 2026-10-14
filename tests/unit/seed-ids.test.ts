import { describe, expect, it } from "vitest";
import {
	buildSeed,
	SEED_MARKER_ID,
	seedId,
	seedIds,
} from "../../src/db/seed/data";
import { SEED_RUN_AT } from "./seed-run-at";

// A UI shows an id's first 8 characters. Seed ids once all began 5eed0000,
// so every short id on a seeded page read the same.
describe("seed ids", () => {
	const ids = (count: number) => {
		const gen = seedIds();
		return Array.from({ length: count }, () => gen.next());
	};

	it("are valid v4 uuids that still mark themselves as seeded", () => {
		for (const id of ids(500)) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-5eed-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		}
	});

	it("differ in their first 8 characters", () => {
		const heads = ids(500).map((id) => id.slice(0, 8));
		expect(new Set(heads).size).toBe(heads.length);
	});

	it("are deterministic, and the marker is the first one", () => {
		expect(ids(50)).toEqual(ids(50));
		expect(seedIds().next()).toBe(SEED_MARKER_ID);
		expect(seedId(1)).toBe(SEED_MARKER_ID);
	});

	it("cover every row the seed builds without colliding", () => {
		const gen = seedIds();
		buildSeed(gen, SEED_RUN_AT);
		const used = gen.next();
		const n = Number(used.slice(-12));
		const all = ids(n);
		expect(new Set(all).size).toBe(n);
		expect(new Set(all.map((id) => id.slice(0, 8))).size).toBe(n);
	});
});
