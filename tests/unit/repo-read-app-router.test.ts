import { describe, expect, it } from "vitest";
import { readRepo } from "../../src/lib/repo-read/index";
import type { Snapshot } from "../../src/lib/repo-read/snapshot";

// The plain feature rule (J, 2026-10-21): src/features/ (else a top-level
// features/) holding two or more directories is a vertical cut, one feature
// each. Route groups under app/ never count; the roster assigns them by hand
// (TEMPLATE-BOOKING.md, Layout and mounts).
const tree = (...paths: string[]): Snapshot => ({
	commitSha: "b00c",
	entries: paths.map((path) => ({ path, size: 1 })),
});

// TEMPLATE-BOOKING.md's Layout and mounts, an app-router tree.
const booking = tree(
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
);

describe("the plain feature rule", () => {
	it("cuts the Booking layout by its feature directories, never its route groups", () => {
		const read = readRepo(booking);
		expect(read.cut).toBe("vertical");
		expect(read.cutEvidence).toBe(
			"commit b00c: feature-organised. src/features/ holds 3 features (accounts/, notifications/, scheduling/), each a feature directory, so one agent per feature.",
		);
	});

	it("reads a top-level features/ when there is no src/features/", () => {
		const read = readRepo(
			tree("app/layout.tsx", "features/a/x.ts", "features/b/y.ts"),
		);
		expect(read.cut).toBe("vertical");
		expect(read.cutEvidence).toContain("features/ holds 2 features (a/, b/)");
	});

	it("needs two feature directories", () => {
		expect(
			readRepo(tree("src/app/page.tsx", "src/features/only/x.ts")).cut,
		).toBeNull();
	});

	it("derives nothing new for a pages-router tree with no features directory", () => {
		const read = readRepo(
			tree(
				"src/pages/index.tsx",
				"src/pages/book.tsx",
				"src/pages/api/slots.ts",
				"src/components/button.tsx",
				"src/lib/clock.ts",
			),
		);
		expect(read.cut).toBeNull();
		expect(read.cutEvidence).toContain("neither");
	});

	it("refuses a tree that is both: feature directories beside layer directories", () => {
		const read = readRepo(
			tree(
				"src/app/page.tsx",
				"src/features/a/x.ts",
				"src/features/b/y.ts",
				"src/services/s.ts",
				"src/routes/r.ts",
			),
		);
		expect(read.cut).toBeNull();
		expect(read.cutEvidence).toContain(
			"both. src/features/ holds feature directories",
		);
	});
});
