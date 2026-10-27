import path from "node:path";
import { DEV_BOOKING_SHA } from "../../lib/templates";
import { buildDevTemplateBooking } from "./dev-template";

export type DevSource = { path: string; head: string; want: string };

/**
 * The clone the dev seed's template-booking playbook opens rooms on, under
 * `dir` (AVEL_SOURCES_DIR): the template-booking fixture at templates/. Its
 * head is returned beside the commit it must be at; a directory already
 * there is left alone, never overwritten. A client's repository is the
 * operator's to clone, at repos/<owner>/<repo>.
 */
export async function buildDevSources(dir: string): Promise<DevSource[]> {
	const clone = path.join(dir, "templates", "template-booking");
	const head = await buildDevTemplateBooking(clone);
	return [{ path: clone, head, want: DEV_BOOKING_SHA }];
}
