import { existsSync } from "node:fs";
import path from "node:path";
import { DEV_BOOKING_SHA } from "../../lib/templates";
import { buildDevTemplateBooking } from "./dev-template";

// `pnpm dev:sources`: builds the template-booking dev fixture under
// AVEL_SOURCES_DIR (from .env when present), so dispatch rooms on avel_dev
// open on the commit the seeded missions pin.
if (existsSync(".env")) process.loadEnvFile(".env");

const dir = process.env.AVEL_SOURCES_DIR;
if (!dir) {
	console.error("AVEL_SOURCES_DIR is not set. See .env.example.");
	process.exit(1);
}

const target = path.join(dir, "templates", "template-booking");
try {
	const head = await buildDevTemplateBooking(target);
	if (head !== DEV_BOOKING_SHA) {
		console.error(
			`${target} is at ${head}, not the fixture's ${DEV_BOOKING_SHA}. Move it aside and run this again.`,
		);
		process.exit(1);
	}
	console.log(`template-booking at ${head} in ${target}`);
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
}
