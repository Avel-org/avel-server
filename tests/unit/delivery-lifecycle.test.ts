import { describe, expect, it } from "vitest";
import {
	EXPORT_STATUSES,
	type ExportStatus,
} from "../../src/contract/shared/status";
import {
	canTransition,
	nextStatuses,
	type TransitionOptions,
} from "../../src/lib/export/delivery";

const TARGETS = ["zip", "github_pr", "github_push"] as const;
const OPTIONS: TransitionOptions[] = TARGETS.flatMap((target) => [
	{ dryRun: true, target },
	{ dryRun: false, target },
]);

function reachable(options: TransitionOptions): Set<ExportStatus> {
	const seen = new Set<ExportStatus>(["pending"]);
	const queue: ExportStatus[] = ["pending"];
	while (queue.length > 0) {
		const from = queue.shift() as ExportStatus;
		for (const to of nextStatuses(from, options)) {
			if (!seen.has(to)) {
				seen.add(to);
				queue.push(to);
			}
		}
	}
	return seen;
}

describe("canTransition", () => {
	it("has no edge out of previewed", () => {
		for (const options of OPTIONS) {
			for (const to of EXPORT_STATUSES) {
				expect(canTransition("previewed", to, options)).toBe(false);
			}
		}
	});

	it("has no edge out of done, closed or failed", () => {
		for (const from of ["done", "closed", "failed"] as const) {
			for (const options of OPTIONS) {
				expect(nextStatuses(from, options)).toEqual([]);
			}
		}
	});

	it("reaches pr-open only for a real github_pr export", () => {
		for (const options of OPTIONS) {
			expect(reachable(options).has("pr-open")).toBe(
				options.target === "github_pr" && !options.dryRun,
			);
		}
	});

	it("ends a dry run at previewed, and never delivers it", () => {
		for (const target of TARGETS) {
			const r = reachable({ dryRun: true, target });
			expect(r.has("previewed")).toBe(true);
			for (const s of ["delivering", "pr-open", "done", "closed"] as const) {
				expect(r.has(s)).toBe(false);
			}
		}
	});

	it("never lets a real export reach previewed", () => {
		for (const target of TARGETS) {
			expect(reachable({ dryRun: false, target }).has("previewed")).toBe(false);
		}
	});

	it("walks each real path", () => {
		const head = [
			"pending",
			"rendering",
			"verifying",
			"previewing",
			"delivering",
		];
		const paths: Array<[TransitionOptions, ExportStatus[]]> = [
			[{ dryRun: false, target: "zip" }, [...head, "done"] as ExportStatus[]],
			[
				{ dryRun: false, target: "github_push" },
				[...head, "done"] as ExportStatus[],
			],
			[
				{ dryRun: false, target: "github_pr" },
				[...head, "pr-open", "done"] as ExportStatus[],
			],
			[
				{ dryRun: false, target: "github_pr" },
				[...head, "pr-open", "closed"] as ExportStatus[],
			],
			[
				{ dryRun: true, target: "github_push" },
				["pending", "rendering", "verifying", "previewing", "previewed"],
			],
		];
		for (const [options, path] of paths) {
			for (let i = 1; i < path.length; i++) {
				expect(
					canTransition(
						path[i - 1] as ExportStatus,
						path[i] as ExportStatus,
						options,
					),
				).toBe(true);
			}
		}
	});

	it("does not let zip or github_push end at pr-open or closed", () => {
		for (const target of ["zip", "github_push"] as const) {
			const options = { dryRun: false, target };
			expect(canTransition("delivering", "pr-open", options)).toBe(false);
			expect(reachable(options).has("closed")).toBe(false);
		}
	});

	it("lets only github_pr leave pr-open for done or closed", () => {
		for (const target of ["zip", "github_push"] as const) {
			for (const to of ["done", "closed"] as const) {
				expect(canTransition("pr-open", to, { dryRun: false, target })).toBe(
					false,
				);
			}
		}
	});

	it("does not let github_pr skip pr-open", () => {
		expect(
			canTransition("delivering", "done", {
				dryRun: false,
				target: "github_pr",
			}),
		).toBe(false);
	});

	it("lets every non-terminal status fail", () => {
		for (const options of OPTIONS) {
			for (const from of [
				"pending",
				"rendering",
				"verifying",
				"previewing",
				"delivering",
				"pr-open",
			] as const) {
				expect(canTransition(from, "failed", options)).toBe(true);
			}
		}
	});

	it("skips no stage and has no self edge", () => {
		const options = { dryRun: false, target: "zip" } as const;
		expect(canTransition("pending", "verifying", options)).toBe(false);
		expect(canTransition("verifying", "delivering", options)).toBe(false);
		for (const s of EXPORT_STATUSES) {
			for (const o of OPTIONS) expect(canTransition(s, s, o)).toBe(false);
		}
	});
});
