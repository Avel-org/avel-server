import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "./errors";

/**
 * The largest request body any /api route reads, in bytes. The biggest
 * contract body is a skill: two 100,000-character Markdown fields, about
 * 1.2 MB if every character were JSON-escaped. 2 MiB leaves room for that.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The Drive's upload route streams its own body against its own cap
 * (AVEL_UPLOAD_MAX_BYTES, src/routes/files.ts), so it is left out here.
 */
const UPLOAD = /^\/api\/intakes\/[^/]+\/files\/?$/;

/**
 * Refuses a body over the cap, declared or streamed, before anything reads
 * it: Better Auth, the router, or the caller check. Answers 400
 * VALIDATION_FAILED in the error envelope, as the upload cap does.
 */
export function limitBody(
	maxBytes: number = MAX_BODY_BYTES,
): MiddlewareHandler {
	const limit = bodyLimit({
		maxSize: maxBytes,
		onError: () => {
			throw new ApiError(
				"VALIDATION_FAILED",
				`The request body is larger than ${maxBytes} bytes`,
			);
		},
	});
	return async (ctx, next) => {
		if (ctx.req.method === "POST" && UPLOAD.test(ctx.req.path)) return next();
		return limit(ctx, next);
	};
}
