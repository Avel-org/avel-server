import { readFileSync } from "node:fs";
import type { TemplateRead } from "../gateways/template-source";

/**
 * The template repositories the Command Center lists, in display order
 * (DECISIONS-V2, Templates are read from their repositories). Configuration
 * under source control: adding a template is a commit. docs/TEMPLATES.md
 * names these first.
 */
export const TEMPLATE_REPOS = [
	"template-booking",
	"template-audit",
	"template-integration",
] as const;

/** Where template-booking's dev manifest says its cover is. */
const DEV_BOOKING_COVER = ".avel/cover.png";

/**
 * template-booking's head in the dev fixture: the commit
 * src/db/seed/dev-template.ts builds, the same on every machine, so a room
 * can open on it. `pnpm dev:sources` puts that clone under AVEL_SOURCES_DIR.
 */
export const DEV_BOOKING_SHA = "3c34369fd2c403ec35f1d24760ff183a840842e2";

/**
 * A dispatch's work on the dev fixture: one commit on DEV_BOOKING_SHA that
 * changes src/features/scheduling/, kept under DEV_GATE_READY_REF. The dev
 * seed's gate-ready mission reports it as its one complete dispatch's
 * result, so that mission can queue a gate job on avel_dev.
 */
export const DEV_GATE_READY_SHA = "612671d7f052c5601344ebe09bdffa776b07583c";
export const DEV_GATE_READY_REF = "refs/avel/dev/gate-ready";

/**
 * What dev reads when no template credential is configured, so the page
 * works on avel_dev with no token. template-booking's sha is the one the
 * seeded missions record. template-integration is unreadable on purpose: it
 * has not been built, and the page must show that row too.
 */
export const DEV_TEMPLATE_READS: Readonly<Record<string, TemplateRead | null>> =
	{
		"template-booking": {
			manifest: {
				name: "Booking",
				scope: "full-stack",
				startingState: "greenfield",
				cover: {
					path: DEV_BOOKING_COVER,
					alt: "A week of booking slots, five taken",
				},
			},
			headSha: DEV_BOOKING_SHA,
		},
		"template-audit": {
			manifest: {
				name: "Audit",
				scope: "audit",
				startingState: "brownfield",
			},
			headSha: "a0d17a0d17a0d17a0d17a0d17a0d17a0d17a0d17",
		},
		"template-integration": null,
	};

/**
 * The dev fixture's files, keyed "slug/path": template-booking's cover, a
 * generated 960x540 PNG, so the cover route can be seen on avel_dev.
 */
export function devTemplateFiles(): Record<string, Uint8Array> {
	return {
		[`template-booking/${DEV_BOOKING_COVER}`]: new Uint8Array(
			readFileSync(
				new URL("./dev-covers/template-booking.png", import.meta.url),
			),
		),
	};
}
