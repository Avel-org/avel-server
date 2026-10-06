import { afterAll, describe, expect, it } from "vitest";
import {
	clientSchema,
	type ErrorCode,
	engagementSchema,
	errorEnvelope,
	preconditionDetails,
	successEnvelope,
	validationDetails,
} from "../../src/contract";
import { statusFor } from "../../src/middleware/errors";
import { type ApiHarness, closeApi, withApi } from "./support";

// Every error path a route handler throws, through the real app and a real
// database. The middleware builds these bodies, so responseValidation does
// not check them; each is parsed here against the contract's strict schema.
async function expectEnvelope(res: Response, code: ErrorCode) {
	expect(res.status, code).toBe(statusFor[code]);
	const body = errorEnvelope.parse(await res.json());
	expect(body.error.code).toBe(code);
	return body;
}

async function newClient(call: ApiHarness["call"]) {
	const res = await call("/api/clients", {
		method: "POST",
		body: { name: "Meridian" },
	});
	return successEnvelope(clientSchema).parse(await res.json()).data.id;
}

async function newEngagement(call: ApiHarness["call"], clientId: string) {
	const res = await call("/api/engagements", {
		method: "POST",
		body: { clientId, name: "Sprint" },
	});
	return successEnvelope(engagementSchema).parse(await res.json()).data.id;
}

const missing = "00000000-0000-4000-8000-000000000999";

describe.skipIf(!process.env.DATABASE_URL)(
	"error paths from route handlers",
	() => {
		afterAll(closeApi);

		it("PRECONDITION_FAILED, each reason, with typed details", async () => {
			await withApi(async ({ signIn, call }) => {
				await signIn();
				const reasonOf = async (res: Response) =>
					preconditionDetails.parse(
						(await expectEnvelope(res, "PRECONDITION_FAILED")).error.details,
					).reason;

				expect(
					await reasonOf(
						await call("/api/engagements", {
							method: "POST",
							body: { clientId: missing, name: "X" },
						}),
					),
				).toBe("client_not_found");

				const busy = await newClient(call);
				await newEngagement(call, busy);
				expect(
					await reasonOf(
						await call(`/api/clients/${busy}`, {
							method: "PATCH",
							body: { status: "closed" },
						}),
					),
				).toBe("client_has_active_engagements");

				const closed = await newClient(call);
				await call(`/api/clients/${closed}`, {
					method: "PATCH",
					body: { status: "closed" },
				});
				expect(
					await reasonOf(
						await call("/api/engagements", {
							method: "POST",
							body: { clientId: closed, name: "X" },
						}),
					),
				).toBe("client_closed");
			});
		});

		it("NOT_FOUND and CONFLICT from resource routes", async () => {
			await withApi(async ({ signIn, call }) => {
				await signIn();
				await expectEnvelope(
					await call(`/api/clients/${missing}`),
					"NOT_FOUND",
				);
				await expectEnvelope(
					await call(`/api/engagements/${missing}`),
					"NOT_FOUND",
				);
				await expectEnvelope(
					await call(`/api/missions/${missing}`),
					"NOT_FOUND",
				);
				const e = await newEngagement(call, await newClient(call));
				await call(`/api/engagements/${e}/close`, { method: "POST" });
				await expectEnvelope(
					await call(`/api/engagements/${e}/close`, { method: "POST" }),
					"CONFLICT",
				);
			});
		});

		it("VALIDATION_FAILED from every source, each with typed issues under the right part", async () => {
			await withApi(async ({ signIn, call }) => {
				await signIn();
				const partsOf = async (res: Response) => {
					const details = validationDetails.parse(
						(await expectEnvelope(res, "VALIDATION_FAILED")).error.details,
					);
					return Object.keys(details);
				};
				const cursor = (value: unknown) =>
					Buffer.from(JSON.stringify(value)).toString("base64url");

				expect(
					await partsOf(
						await call("/api/clients", { method: "POST", body: { name: "" } }),
					),
				).toEqual(["body"]);
				expect(await partsOf(await call("/api/clients/not-a-uuid"))).toEqual([
					"params",
				]);
				expect(await partsOf(await call("/api/clients?limit=0"))).toEqual([
					"query",
				]);
				expect(
					await partsOf(
						await call(`/api/clients?cursor=${cursor(["x", "-".repeat(36)])}`),
					),
				).toEqual(["query"]);
				expect(
					await partsOf(
						await call(
							`/api/missions?origin=client&cursor=${cursor(["sprint", 1, missing])}`,
						),
					),
				).toEqual(["query"]);
				expect(
					await partsOf(await call("/api/missions?origin=client&cursor=%%%")),
				).toEqual(["query"]);
			});
		});
	},
);
