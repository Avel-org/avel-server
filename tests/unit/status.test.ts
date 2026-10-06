import { describe, expect, it } from "vitest";
import {
	EXPORT_STATUSES,
	exportStatus,
	MISSION_STATUSES,
	missionStatus,
} from "../../src/contract";

// These arrays are the single source for the pgEnums, so their values and
// order are pinned here. Changing either is a contract and migration change.
describe("status vocabularies", () => {
	it("pins the mission statuses, in order", () => {
		expect(MISSION_STATUSES).toEqual([
			"draft",
			"active",
			"halted",
			"shipped",
			"archived",
		]);
		expect(missionStatus.options).toEqual(MISSION_STATUSES);
	});

	it("pins the export statuses, in order", () => {
		expect(EXPORT_STATUSES).toEqual([
			"pending",
			"rendering",
			"verifying",
			"previewing",
			"previewed",
			"delivering",
			"pr-open",
			"done",
			"closed",
			"failed",
		]);
		expect(exportStatus.options).toEqual(EXPORT_STATUSES);
	});

	it("refuses a value outside each vocabulary", () => {
		expect(missionStatus.safeParse("closed").success).toBe(false);
		expect(exportStatus.safeParse("halted").success).toBe(false);
	});
});
