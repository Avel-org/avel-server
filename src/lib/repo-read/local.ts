import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isSkipped,
	LIMITS,
	type Limits,
	type Snapshot,
	SnapshotBuilder,
} from "./snapshot";

/**
 * A directory on disk as a Snapshot, for internal templates and for
 * regenerating test fixtures. readdir order is not stable across platforms,
 * so the builder sorts; symlinks are not followed.
 */
export function snapshotFromDirectory(
	root: string,
	commitSha: string,
	limits: Limits = LIMITS,
): Snapshot {
	const builder = new SnapshotBuilder(limits);
	const walk = (dir: string, rel: string) => {
		for (const d of readdirSync(dir, { withFileTypes: true })) {
			const path = rel ? `${rel}/${d.name}` : d.name;
			if (d.isDirectory()) {
				if (!isSkipped(`${path}/`)) walk(join(dir, d.name), path);
			} else if (d.isFile()) {
				builder.add(path, readFileSync(join(dir, d.name)));
			}
		}
	};
	walk(root, "");
	return builder.build(commitSha);
}
