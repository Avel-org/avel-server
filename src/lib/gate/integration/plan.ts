import type { CompletionStatus } from "../../../contract/shared/status";
import type { FileChange } from "../../../rooms/checkpoint";
import { COMMIT_SHA } from "../../../rooms/git";

/** One closed dispatch and every path its room changed since the pinned commit. */
export type IntegrationDispatch = {
	id: string;
	status: CompletionStatus;
	/** When the dispatch closed, as Date.toISOString() writes it. */
	closedAt: string;
	/**
	 * Every path its room changed since the commit it started from:
	 * `startSha`, or the mission's base for a dispatch with none.
	 */
	changes: readonly FileChange[];
	/**
	 * The commit its room opened on (decided 2026-10-22: rooms start from
	 * finished work), its result commit's parent. Absent on a dispatch
	 * started before that: it started from the base.
	 */
	startSha?: string;
	/** The complete dispatches its start commit was built from; none when absent. */
	saw?: readonly string[];
};

/** Write the path as the dispatch left it, or delete it. */
export type IntegrationOp = { op: "write" | "delete"; path: string };

export type IntegrationStep = {
	dispatchId: string;
	closedAt: string;
	/** The parent its result commit must have: its start commit, or the base. */
	startSha: string;
	/** One op per path, sorted by path. */
	ops: IntegrationOp[];
};

export type ExcludedDispatch = {
	dispatchId: string;
	status: Exclude<CompletionStatus, "complete">;
	closedAt: string;
};

export type IntegrationConflict = { path: string; dispatchIds: string[] };

export type IntegrationPlan =
	| {
			ok: true;
			baseSha: string;
			steps: IntegrationStep[];
			excluded: ExcludedDispatch[];
	  }
	| {
			ok: false;
			baseSha: string;
			conflicts: IntegrationConflict[];
			excluded: ExcludedDispatch[];
	  };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * How a mission's work is laid onto its pinned commit to make the commit the
 * gate judges. Pure; the git half that reads each dispatch's bytes is not
 * built. Only complete dispatches integrate. Blocked, halted and failed ones
 * are listed as excluded, and their paths are never laid down.
 *
 * A path that two complete dispatches touched, by any change (a rename
 * touches both its paths), is a conflict when neither saw the other's
 * change: neither started from work that held the other (decided
 * 2026-10-22; it replaces the 2026-10-19 rule that any shared path is a
 * conflict). A later dispatch may change an earlier one's file, and its
 * change, laid down after, wins. A conflict stands even when both made the
 * same change. Every conflicting path is listed with each dispatch in a
 * pair that did not see each other, and nothing is planned: there is no
 * merging and no guessing.
 *
 * Otherwise each dispatch is one step, in close order (ties by id). Each
 * touched path is written when the dispatch left it in place (added,
 * modified, or a rename's target) and deleted otherwise, so a path a rename
 * moved away and the same dispatch added again is written.
 */
export function planIntegration(input: {
	baseSha: string;
	dispatches: readonly IntegrationDispatch[];
}): IntegrationPlan {
	if (!COMMIT_SHA.test(input.baseSha)) {
		throw new Error(`The base ${input.baseSha} is not a full commit sha`);
	}
	const seen = new Set<string>();
	for (const d of input.dispatches) {
		if (seen.has(d.id))
			throw new Error(`Dispatch ${d.id} is listed more than once`);
		seen.add(d.id);
		if (!ISO.test(d.closedAt)) {
			throw new Error(`Dispatch ${d.id} has closedAt ${d.closedAt}`);
		}
		if (d.startSha !== undefined && !COMMIT_SHA.test(d.startSha)) {
			throw new Error(`Dispatch ${d.id} has start ${d.startSha}`);
		}
	}
	const saw = new Map(
		input.dispatches.map((d) => [d.id, new Set(d.saw ?? [])] as const),
	);
	const seenBetween = (a: string, b: string) =>
		(saw.get(a)?.has(b) ?? false) || (saw.get(b)?.has(a) ?? false);

	const ordered = [...input.dispatches].sort(
		(a, b) => cmp(a.closedAt, b.closedAt) || cmp(a.id, b.id),
	);
	const excluded: ExcludedDispatch[] = [];
	const complete: IntegrationDispatch[] = [];
	for (const d of ordered) {
		if (d.status === "complete") complete.push(d);
		else
			excluded.push({
				dispatchId: d.id,
				status: d.status,
				closedAt: d.closedAt,
			});
	}

	const touchedBy = new Map<string, string[]>();
	const steps = complete.map((d): IntegrationStep => {
		const written = new Set<string>();
		const touched = new Set<string>();
		for (const c of d.changes) {
			touched.add(c.path);
			if (c.kind === "renamed") {
				touched.add(c.from);
				written.add(c.path);
			} else if (c.kind !== "deleted") {
				written.add(c.path);
			}
		}
		for (const path of touched) {
			touchedBy.set(path, [...(touchedBy.get(path) ?? []), d.id]);
		}
		return {
			dispatchId: d.id,
			closedAt: d.closedAt,
			startSha: d.startSha ?? input.baseSha,
			ops: [...touched].sort(cmp).map((path) => ({
				op: written.has(path) ? "write" : "delete",
				path,
			})),
		};
	});

	const conflicts = [...touchedBy]
		.map(([path, ids]) => {
			const unseen = new Set<string>();
			for (const [i, a] of ids.entries()) {
				for (const b of ids.slice(i + 1)) {
					if (!seenBetween(a, b)) {
						unseen.add(a);
						unseen.add(b);
					}
				}
			}
			return { path, dispatchIds: [...unseen].sort(cmp) };
		})
		.filter((c) => c.dispatchIds.length > 0)
		.sort((a, b) => cmp(a.path, b.path));
	if (conflicts.length > 0) {
		return { ok: false, baseSha: input.baseSha, conflicts, excluded };
	}
	return { ok: true, baseSha: input.baseSha, steps, excluded };
}

/** Code-unit order, never locale order (DEV-TIPS §2). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
