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

/** template-booking's head in the dev fixture. Made up; it only has to be 40 hex. */
export const DEV_BOOKING_SHA = "b00c1e9b00c1e9b00c1e9b00c1e9b00c1e9b00c1";

/**
 * What dev reads when no template credential is configured, so the page
 * works on avel_dev under dev preview. template-booking's sha is the one the
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
