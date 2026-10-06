import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";

const c = initContract();

/** Must equal the engagement_status pgEnum; tests/api/engagement.test.ts checks it. */
export const engagementStatus = z.enum(["active", "closed"]);

export type EngagementStatus = z.infer<typeof engagementStatus>;

const name = z.string().trim().min(1).max(200);
const scopeMd = z.string().max(20_000).nullable();

export const engagementSchema = z.object({
	id: z.string().uuid(),
	clientId: z.string().uuid(),
	name: z.string(),
	scopeMd: z.string().nullable(),
	status: engagementStatus,
	startedAt: z.string().datetime(),
	closedAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export type Engagement = z.infer<typeof engagementSchema>;

/** What close answers: the engagement, and how many of its connections it revoked. */
export const closedEngagementSchema = engagementSchema.extend({
	revokedConnections: z.number().int().nonnegative(),
});

export type ClosedEngagement = z.infer<typeof closedEngagementSchema>;

/**
 * A new engagement is active, under an active client. `startedAt` defaults to
 * the server's clock.
 */
export const createEngagementBody = z
	.object({
		clientId: z.string().uuid(),
		name,
		scopeMd: scopeMd.optional(),
		startedAt: z.string().datetime().optional(),
	})
	.strict();

/** Status changes only through close. The client never changes. */
export const updateEngagementBody = z
	.object({
		name: name.optional(),
		scopeMd: scopeMd.optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

export const engagementListQuery = pageQuery.extend({
	clientId: z.string().uuid().optional(),
	status: engagementStatus.optional(),
});

const byId = z.object({ id: z.string().uuid() });

export const engagementContract = c.router({
	list: {
		method: "GET",
		path: "/api/engagements",
		query: engagementListQuery,
		responses: { 200: pageEnvelope(engagementSchema) },
		summary: "Engagements, newest first, optionally for one client",
	},
	get: {
		method: "GET",
		path: "/api/engagements/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(engagementSchema) },
	},
	create: {
		method: "POST",
		path: "/api/engagements",
		body: createEngagementBody,
		responses: { 201: successEnvelope(engagementSchema) },
	},
	update: {
		method: "PATCH",
		path: "/api/engagements/:id",
		pathParams: byId,
		body: updateEngagementBody,
		responses: { 200: successEnvelope(engagementSchema) },
	},
	close: {
		method: "POST",
		path: "/api/engagements/:id/close",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(closedEngagementSchema) },
		summary:
			"Sets status closed and closedAt from the server's clock. Closing twice is 409 CONFLICT.",
	},
});
