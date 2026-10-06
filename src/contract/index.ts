import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { clientContract } from "./client";
import { engagementContract } from "./engagement";
import { missionContract } from "./mission";
import { errorEnvelope, successEnvelope } from "./shared/envelope";

export * from "./agent-template";
export * from "./client";
export * from "./engagement";
export * from "./mission";
export * from "./shared/envelope";
export * from "./shared/errors";
export * from "./shared/pagination";
export * from "./shared/status";
export * from "./skill";
export * from "./skill-source";

/**
 * The contract between avel-server and every client: web, desktop, mobile.
 *
 * It lives here and avel-web consumes it as a dependency, so neither side can
 * change it without the other seeing the change.
 *
 * Every JSON route answers with the success envelope, and any route can
 * answer any of ERROR_STATUSES with the error envelope.
 */
const c = initContract();

export const healthResponse = z.object({
	ok: z.literal(true),
	service: z.literal("avel-server"),
	time: z.string().datetime(),
	/** True while dev preview lets sessionless reads through (AVEL_DEV_PREVIEW). */
	preview: z.boolean(),
});

export const contract = c.router(
	{
		health: {
			method: "GET",
			path: "/api/health",
			responses: { 200: successEnvelope(healthResponse) },
			summary: "Liveness, plus the server's clock — which tests can fix",
		},
		clients: clientContract,
		engagements: engagementContract,
		missions: missionContract,
	},
	{
		// One entry per ERROR_STATUSES value. Written out, not mapped, so ts-rest
		// infers each status literally; tests/unit/error-mapping.test.ts checks
		// the two lists agree.
		commonResponses: {
			400: errorEnvelope,
			401: errorEnvelope,
			403: errorEnvelope,
			404: errorEnvelope,
			409: errorEnvelope,
			422: errorEnvelope,
			500: errorEnvelope,
			502: errorEnvelope,
		},
	},
);
