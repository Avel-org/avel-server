import { COMMIT_SHA, git } from "../../rooms/git";
import type { RemoteEntry, RemoteTree } from "./delivery/types";

/**
 * A commit's whole tree from the git clone at `source`, in the shape the
 * blast radius reads: every blob, symlink, submodule and directory by path,
 * with its mode and object sha. A zip export reads the mission's base this
 * way, so its violations come from the base it will be unpacked onto,
 * without a network read.
 */
export async function localTree(
	source: string,
	commitSha: string,
): Promise<RemoteTree> {
	if (!COMMIT_SHA.test(commitSha)) {
		throw new Error(`The commit ${commitSha} is not a full sha`);
	}
	const listing = await git(
		["ls-tree", "-r", "-t", "-z", "--full-tree", commitSha],
		{ cwd: source },
	);
	const entries = new Map<string, RemoteEntry>();
	for (const entry of listing.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const [mode, , sha] = entry.slice(0, tab).split(" ");
		if (!mode || !sha) {
			throw new Error(`ls-tree gave an entry out of format: ${entry}`);
		}
		entries.set(entry.slice(tab + 1), { sha, mode });
	}
	return { commitSha, entries };
}
