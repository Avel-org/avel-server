import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { finding, findingStatus, permanentCheck } from "./agent";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";

const c = initContract();

const uuid = z.string().uuid();

export const findingListQuery = pageQuery.extend({
	status: findingStatus.optional(),
});

export const findingListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(finding),
	meta: pageMeta.extend({
		/** Over the whole mission, ignoring the status filter. */
		counts: z.object({
			open: z.number().int().nonnegative(),
			confirmed: z.number().int().nonnegative(),
			dismissed: z.number().int().nonnegative(),
		}),
	}),
});

const byId = z.object({ id: uuid });

/**
 * The operator's triage of judges' findings (module 9, decided 2026-10-19).
 * A judge files a finding open; only the operator confirms or dismisses it,
 * and decide() reads the result: open blocks, confirmed blocks unless
 * overridden, dismissed passes.
 */
export const findingContract = c.router({
	list: {
		method: "GET",
		path: "/api/missions/:id/findings",
		pathParams: byId,
		query: findingListQuery,
		responses: { 200: findingListEnvelope },
		summary: "The mission's findings, newest first, with counts by status",
	},
	confirm: {
		method: "POST",
		path: "/api/findings/:id/confirm",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(finding) },
		summary: "open → confirmed, by the operator",
	},
	dismiss: {
		method: "POST",
		path: "/api/findings/:id/dismiss",
		pathParams: byId,
		body: z.object({ reason: z.string().trim().min(1) }).strict(),
		responses: { 200: successEnvelope(finding) },
		summary: "open → dismissed, with the operator's reason",
	},
	setCheck: {
		method: "PUT",
		path: "/api/findings/:id/check",
		pathParams: byId,
		body: z.object({ check: permanentCheck.nullable() }).strict(),
		responses: { 200: successEnvelope(finding) },
		summary:
			"Attach, replace or remove a confirmed finding's permanent check, which gates every later mission in its scope",
	},
});
