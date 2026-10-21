import { describe, expect, it } from "vitest";
import { readRepo } from "../../src/lib/repo-read/index";
import type { Snapshot } from "../../src/lib/repo-read/snapshot";

// TEMPLATE-BOOKING.md's Layout and mounts, an app-router tree. ROSTER-V2
// calls app-router colocation feature-organised, but no rule says what
// makes an app-router feature, or whether route groups are boundaries, so
// today's answer is no cut. This pins it until the rule is decided.
const booking: Snapshot = {
	commitSha: "b00c",
	entries: [
		"src/app/layout.tsx",
		"src/app/(public)/page.tsx",
		"src/app/(public)/book/page.tsx",
		"src/app/admin/login/page.tsx",
		"src/app/admin/(manage)/bookings/page.tsx",
		"src/app/api/(scheduling)/availability/route.ts",
		"src/app/api/auth/[...all]/route.ts",
		"src/app/api/cron/route.ts",
		"src/features/scheduling/schema.ts",
		"src/features/scheduling/availability.ts",
		"src/features/scheduling/sql/overlap.sql",
		"src/features/notifications/schema.ts",
		"src/features/notifications/send.ts",
		"src/features/accounts/schema.ts",
		"src/features/accounts/session.ts",
		"src/lib/clock.ts",
		"src/ui/button.tsx",
	].map((path) => ({ path, size: 1 })),
};

describe("an app-router tree", () => {
	it("derives no cut yet: its features have no layers the rule can see", () => {
		const read = readRepo(booking);
		expect(read.cut).toBeNull();
		expect(read.cutEvidence).toContain("neither");
	});
});
