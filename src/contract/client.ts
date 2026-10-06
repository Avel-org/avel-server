import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { successEnvelope } from "./shared/envelope";
import { pageEnvelope, pageQuery } from "./shared/pagination";

const c = initContract();

/** Must equal the client_status pgEnum; tests/api/client.test.ts checks it. */
export const clientStatus = z.enum(["active", "closed"]);

export type ClientStatus = z.infer<typeof clientStatus>;

const name = z.string().trim().min(1).max(200);
const primaryContact = z.string().trim().max(200).nullable();
const notesMd = z.string().max(20_000).nullable();

export const clientSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	status: clientStatus,
	primaryContact: z.string().nullable(),
	notesMd: z.string().nullable(),
	/** Live (not deleted) engagements, so a client list needs no per-row engagement query. */
	engagementCount: z.number().int().nonnegative(),
	/** The live engagements whose status is active. */
	activeEngagementCount: z.number().int().nonnegative(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export type Client = z.infer<typeof clientSchema>;

/** A new client is always active. */
export const createClientBody = z
	.object({
		name,
		primaryContact: primaryContact.optional(),
		notesMd: notesMd.optional(),
	})
	.strict();

export const updateClientBody = z
	.object({
		name: name.optional(),
		status: clientStatus.optional(),
		primaryContact: primaryContact.optional(),
		notesMd: notesMd.optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Give at least one field to change",
	});

const byId = z.object({ id: z.string().uuid() });

export const clientContract = c.router({
	list: {
		method: "GET",
		path: "/api/clients",
		query: pageQuery,
		responses: { 200: pageEnvelope(clientSchema) },
		summary: "Clients, newest first",
	},
	get: {
		method: "GET",
		path: "/api/clients/:id",
		pathParams: byId,
		responses: { 200: successEnvelope(clientSchema) },
	},
	create: {
		method: "POST",
		path: "/api/clients",
		body: createClientBody,
		responses: { 201: successEnvelope(clientSchema) },
	},
	update: {
		method: "PATCH",
		path: "/api/clients/:id",
		pathParams: byId,
		body: updateClientBody,
		responses: { 200: successEnvelope(clientSchema) },
	},
});
