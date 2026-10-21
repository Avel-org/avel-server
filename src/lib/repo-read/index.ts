import type { Boundary, ConventionSet } from "../../contract/repo-read";
import { deriveBoundaries } from "./boundaries";
import { extractConventions } from "./conventions";
import { deriveCut } from "./cut";
import { detectLanguages, type LanguageCount } from "./languages";
import type { Snapshot } from "./snapshot";

export type RepoRead = {
	commitSha: string;
	cut: "horizontal" | "vertical" | null;
	cutEvidence: string;
	conventions: ConventionSet;
	boundaries: Boundary[];
	/**
	 * Not stored and not on the wire: a column would be a schema change. The
	 * gate can run detectLanguages on the commit it judges.
	 */
	languages: LanguageCount[];
};

/**
 * One read of one commit, three outputs and the languages (DECISIONS-V2, "Convention and
 * boundary extraction"). Pure: no I/O, no clock, the same snapshot always
 * gives the same result. Code, never a model.
 */
export function readRepo(input: Snapshot): RepoRead {
	// Evidence samples follow entry order, so the order is fixed here rather
	// than trusted from the source: byte order, never locale.
	const snapshot = {
		commitSha: input.commitSha,
		entries: [...input.entries].sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		),
	};
	const cut = deriveCut(snapshot);
	return {
		commitSha: snapshot.commitSha,
		cut: cut.cut,
		cutEvidence: cut.evidence,
		conventions: extractConventions(snapshot, cut),
		boundaries: deriveBoundaries(snapshot, cut),
		languages: detectLanguages(snapshot),
	};
}
