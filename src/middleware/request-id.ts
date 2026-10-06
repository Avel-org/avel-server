import type { MiddlewareHandler } from "hono";
import type { IdGenerator } from "../lib/ids";
import { UNAVAILABLE_REQUEST_ID } from "./errors";

export type RequestIdVariables = { requestId: string };

/**
 * Gives each request an id from the injected generator and echoes it in
 * `x-request-id`. The id is never read from the incoming request, so a client
 * cannot choose what appears in the server's logs.
 *
 * The placeholder is set before the generator runs, so if the generator is
 * what throws, the error handler still has an id to answer with.
 */
export function requestId(
	ids: IdGenerator,
): MiddlewareHandler<{ Variables: RequestIdVariables }> {
	return async (ctx, next) => {
		ctx.set("requestId", UNAVAILABLE_REQUEST_ID);
		ctx.set("requestId", ids.next());
		await next();
		ctx.header("x-request-id", ctx.get("requestId"));
	};
}
