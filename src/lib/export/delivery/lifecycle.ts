import {
	EXPORT_STATUSES,
	type ExportStatus,
} from "../../../contract/shared/status";
import type { DeliveryTarget } from "./guards";

/**
 * The export lifecycle (BLAST-RADIUS.md, Lifecycle; DATA-CONTRACTS-V2.md,
 * Export):
 *
 *   pending -> rendering -> verifying -> previewing
 *   dry run:  previewing -> previewed             (terminal)
 *   real:     previewing -> delivering -> done    zip, github_push
 *             previewing -> delivering -> pr-open -> done | closed   github_pr
 *   any non-terminal status -> failed
 *
 * `previewed` is terminal, so a dry run can never be promoted. Every real
 * export, zip included, passes through `previewing`.
 */
export type TransitionOptions = { dryRun: boolean; target: DeliveryTarget };

export const TERMINAL_STATUSES: readonly ExportStatus[] = Object.freeze([
	"previewed",
	"done",
	"closed",
	"failed",
]);

export function canTransition(
	from: ExportStatus,
	to: ExportStatus,
	{ dryRun, target }: TransitionOptions,
): boolean {
	if (TERMINAL_STATUSES.includes(from)) return false;
	if (to === "failed") return true;
	switch (from) {
		case "pending":
			return to === "rendering";
		case "rendering":
			return to === "verifying";
		case "verifying":
			return to === "previewing";
		case "previewing":
			return dryRun ? to === "previewed" : to === "delivering";
		case "delivering":
			if (dryRun) return false;
			return target === "github_pr" ? to === "pr-open" : to === "done";
		case "pr-open":
			return (
				!dryRun && target === "github_pr" && (to === "done" || to === "closed")
			);
		default:
			return false;
	}
}

/** Every status, in EXPORT_STATUSES order, that `from` may move to. */
export function nextStatuses(
	from: ExportStatus,
	options: TransitionOptions,
): ExportStatus[] {
	return EXPORT_STATUSES.filter((to) => canTransition(from, to, options));
}
