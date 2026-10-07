// Regenerates a repo-read test fixture from a real directory:
//
//   pnpm tsx scripts/repo-fixture.ts <directory> <out.json> [commit-sha]
//
// The directory is read with the same local source the server uses
// (src/lib/repo-read/local.ts), so a fixture is exactly what a read of that
// tree sees. node_modules, .git, vendor and dist are skipped. The sha
// defaults to the directory's name padded to 40 hex characters, so
// regenerating the same tree gives the same file.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { snapshotFromDirectory } from "../src/lib/repo-read/local";

const [dir, out, sha] = process.argv.slice(2);
if (!dir || !out) {
	console.error(
		"usage: pnpm tsx scripts/repo-fixture.ts <directory> <out.json> [sha]",
	);
	process.exit(1);
}
const name = basename(dir);
const fallback = Buffer.from(name).toString("hex").padEnd(40, "0").slice(0, 40);
const snapshot = snapshotFromDirectory(dir, sha ?? fallback);
writeFileSync(out, `${JSON.stringify(snapshot, null, "\t")}\n`);
console.log(
	`${out}: ${snapshot.entries.length} files at ${snapshot.commitSha}`,
);
