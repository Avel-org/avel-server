import { git } from "./git";
import { matchesGlob } from "./globs";

/** One file a brief's Read section names: its path and its git blob sha. */
export type ReadFile = { path: string; blobSha: string };

/** One module read and the files it matched at the commit, sorted by path. */
export type ReadMatch = { read: string; files: ReadFile[] };

/**
 * A blob entry of `git ls-tree -r -z`: "<mode> blob <sha>\t<path>". Symlinks
 * (120000) are left out, because the room's file tools refuse them; so are
 * submodules, which are commits, not blobs.
 */
export function lsTreeBlobs(listing: string): ReadFile[] {
	const files: ReadFile[] = [];
	for (const entry of listing.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const [mode, type, sha] = entry.slice(0, tab).split(" ");
		if (type !== "blob" || mode === "120000" || !sha) continue;
		files.push({ path: entry.slice(tab + 1), blobSha: sha });
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Whether a file is one a read names: the read as a glob (src/rooms/globs.ts),
 * or, for a read that names a directory, anything under it.
 */
export function readMatches(path: string, read: string): boolean {
	const r = read.trim().replace(/\/+$/, "");
	return matchesGlob(path, r) || matchesGlob(path, `${r}/**`);
}

/** Each read's files from a tree's blobs, in the reads' order. Pure. */
export function matchReads(
	files: readonly ReadFile[],
	reads: readonly string[],
): ReadMatch[] {
	return reads.map((read) => ({
		read,
		files: files.filter((f) => readMatches(f.path, read)),
	}));
}

/**
 * The files each read names in the clone at `commit`, read from git's tree
 * rather than a checkout, so the answer is the commit's and nothing else.
 */
export async function readSet(
	repoPath: string,
	commit: string,
	reads: readonly string[],
): Promise<ReadMatch[]> {
	if (reads.length === 0) return [];
	const listing = await git(["ls-tree", "-r", "-z", "--full-tree", commit], {
		cwd: repoPath,
	});
	return matchReads(lsTreeBlobs(listing), reads);
}
