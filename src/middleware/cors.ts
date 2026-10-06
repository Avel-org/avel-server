import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

/**
 * Credentialed CORS for the non-browser-proxy clients: the Tauri desktop and
 * mobile builds. The browser web app reaches /api/* through its own origin's
 * proxy and needs no CORS. Exact-match origins only; a listed origin is
 * echoed back, any other gets no CORS headers at all.
 */
export function corsFor(origins: readonly string[]): MiddlewareHandler {
	const allowed = new Set(origins);
	const handler = cors({
		origin: (origin) => (allowed.has(origin) ? origin : null),
		credentials: true,
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["content-type"],
		exposeHeaders: ["x-request-id"],
		maxAge: 600,
	});
	// Hono's cors() sets allow-credentials whatever the origin, so an unlisted
	// origin skips it entirely and gets no CORS headers.
	return async (ctx, next) => {
		const origin = ctx.req.header("origin");
		return origin && allowed.has(origin) ? handler(ctx, next) : next();
	};
}
