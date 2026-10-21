import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDevTemplateBooking } from "../../src/db/seed/dev-template";
import { DEV_BOOKING_SHA } from "../../src/lib/templates";

// The seeded missions pin DEV_BOOKING_SHA. If the fixture's files change
// and the constant does not, every dispatch start on avel_dev refuses
// source_unavailable, because no clone holds that commit.
describe("template-booking dev fixture", () => {
	const root = mkdtempSync(path.join(tmpdir(), "avel-dev-template-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("builds the commit the seed pins", async () => {
		expect(await buildDevTemplateBooking(path.join(root, "a"))).toBe(
			DEV_BOOKING_SHA,
		);
	});

	it("leaves a clone already at its head alone", async () => {
		const dir = path.join(root, "b");
		const first = await buildDevTemplateBooking(dir);
		expect(await buildDevTemplateBooking(dir)).toBe(first);
	});
});
