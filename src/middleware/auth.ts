import type { MiddlewareHandler } from "hono";
import type { Auth, Operator } from "../auth";
import { ApiError } from "./errors";
import type { RequestIdVariables } from "./request-id";

export type AuthVariables = RequestIdVariables & { operator: Operator };

/** Marks every /api response while dev preview is on, errors included. */
export function previewHeader(): MiddlewareHandler {
	return async (ctx, next) => {
		await next();
		ctx.header("x-avel-preview", "1");
	};
}

/** Paths under /api/* that answer without a session. Everything else requires one. */
export function isPublicPath(path: string): boolean {
	return path === "/api/health" || path.startsWith("/api/auth/");
}

/**
 * Requires a signed-in operator on every /api/* route except the public ones.
 * An unknown route answers 401 before 404, so a caller without a session
 * cannot map which routes exist.
 */
export function requireOperator(
	auth: Auth,
	options: { preview: boolean },
): MiddlewareHandler<{ Variables: AuthVariables }> {
	return async (ctx, next) => {
		if (isPublicPath(ctx.req.path)) return next();
		const result = await auth.operatorFor(ctx.req.raw.headers);
		// Dev preview (src/auth/preview.ts): a read with no session passes,
		// as nobody. No operator is set, so a handler that writes refuses on
		// its own (operatorOf). A real session never takes this path: it
		// still gets the allowlist check below.
		if (
			options.preview &&
			"refused" in result &&
			result.refused === "no_session" &&
			(ctx.req.method === "GET" || ctx.req.method === "HEAD")
		) {
			return next();
		}
		if ("refused" in result) {
			throw result.refused === "no_session"
				? new ApiError("UNAUTHENTICATED", "Sign in to continue")
				: new ApiError(
						"NOT_OPERATOR",
						"This GitHub account is not an operator",
					);
		}
		ctx.set("operator", result.operator);
		await next();
		// A slid session's fresh cookie (see operatorFor), on whatever the
		// route answered.
		for (const cookie of result.setCookies) {
			ctx.header("set-cookie", cookie, { append: true });
		}
	};
}

/**
 * Every POST to Better Auth must come from a trusted origin. Better Auth
 * checks the Origin header only when the request carries cookies, so a
 * cookieless cross-site POST could otherwise start a sign-in. A missing
 * Origin is refused too: browsers and the Tauri webviews always send one.
 */
export function requireTrustedOrigin(
	trusted: readonly string[],
): MiddlewareHandler {
	const allowed = new Set(trusted);
	return async (ctx, next) => {
		if (ctx.req.method !== "POST") return next();
		const origin = ctx.req.header("origin");
		if (!origin || !allowed.has(origin)) {
			throw new ApiError("FORBIDDEN", "This origin may not call sign-in");
		}
		return next();
	};
}
