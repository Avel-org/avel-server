import { existsSync } from "node:fs";
import { buildDevSources } from "./dev-sources";

// `pnpm dev:sources`: builds the dev seed's clones under AVEL_SOURCES_DIR
// (from .env when present): the template-booking dev fixture, and each
// seeded client mission's repository at the commit its intake read, so
// dispatch rooms on avel_dev open on a commit a clone really holds.
if (existsSync(".env")) process.loadEnvFile(".env");

const dir = process.env.AVEL_SOURCES_DIR;
if (!dir) {
	console.error("AVEL_SOURCES_DIR is not set. See .env.example.");
	process.exit(1);
}

try {
	let wrong = false;
	for (const s of await buildDevSources(dir)) {
		if (s.head !== s.want) {
			wrong = true;
			console.error(
				`${s.path} is at ${s.head}, not ${s.want}. Move it aside and run this again.`,
			);
		} else {
			console.log(`${s.head} in ${s.path}`);
		}
	}
	if (wrong) process.exit(1);
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
}
