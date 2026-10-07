import {
	fetchRequestHandler,
	TsRestResponse,
	tsr,
} from "@ts-rest/serverless/fetch";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Auth, REQUEST_ID_HEADER } from "./auth";
import { contract } from "./contract";
import type { Executor } from "./db/tx";
import type { Clock } from "./lib/clock";
import type { IdGenerator } from "./lib/ids";
import type { Logger } from "./lib/logger";
import {
	type AuthVariables,
	previewHeader,
	requireOperator,
	requireTrustedOrigin,
} from "./middleware/auth";
import { corsFor } from "./middleware/cors";
import {
	ApiError,
	isRouteNotFound,
	loggerReporter,
	toErrorEnvelope,
	UNAVAILABLE_REQUEST_ID,
} from "./middleware/errors";
import { requestId } from "./middleware/request-id";
import { activityRoutes } from "./routes/activity";
import { agentTemplateRoutes } from "./routes/agent-templates";
import { clientRoutes } from "./routes/clients";
import { engagementRoutes } from "./routes/engagements";
import { health } from "./routes/health";
import { intakeRoutes } from "./routes/intake";
import { missionRoutes } from "./routes/missions";
import { presetRoutes } from "./routes/presets";
import { rosterRoutes } from "./routes/roster";
import type { RequestContext } from "./routes/shared";
import { skillSourceRoutes } from "./routes/skill-sources";
import { skillRoutes } from "./routes/skills";

export type AppDeps = {
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	auth: Auth;
	/** The pool in production. Tests pass an open transaction they roll back. */
	db: () => Executor;
	/** Origins allowed credentialed CORS (the Tauri builds). Empty means none. */
	webOrigins: readonly string[];
	/** Dev preview (src/auth/preview.ts): sessionless reads. False everywhere but a local _dev run. */
	preview: boolean;
};

/**
 * The HTTP app. Dependencies are passed in, never reached for, so a test can
 * build the same app with a fixed clock and sequential ids and compare
 * responses exactly.
 *
 * Every failure under /api/* answers with the error envelope from
 * src/contract/shared/envelope.ts.
 */
export function createApp(deps: AppDeps) {
	const report = loggerReporter(deps.logger);
	const routeDeps = { db: deps.db, clock: deps.clock, ids: deps.ids };
	const router = tsr.platformContext<RequestContext>().router(contract, {
		health: health(deps.clock, deps.preview),
		clients: clientRoutes(routeDeps),
		engagements: engagementRoutes(routeDeps),
		missions: missionRoutes(routeDeps),
		activity: activityRoutes(routeDeps),
		intakes: intakeRoutes(routeDeps),
		agentTemplates: agentTemplateRoutes(routeDeps),
		skills: skillRoutes(routeDeps),
		skillSources: skillSourceRoutes(routeDeps),
		roster: rosterRoutes(routeDeps),
		presets: presetRoutes(routeDeps),
	});

	const app = new Hono<{ Variables: AuthVariables }>();

	// First, so a preflight is answered before auth can refuse it.
	// Outermost, so every /api response carries it, errors included.
	if (deps.preview) app.use("/api/*", previewHeader());
	app.use("/api/*", corsFor(deps.webOrigins));
	app.use("/api/*", requestId(deps.ids));
	// After the request id, so a refusal still carries one.
	app.use("/api/*", requireOperator(deps.auth, { preview: deps.preview }));

	app.use("/api/auth/*", requireTrustedOrigin(deps.auth.trustedOrigins));
	// Better Auth's own routes: sign-in, the OAuth callback, session, sign-out.
	// A non-contract route, so its responses are Better Auth's, not envelopes.
	app.on(["GET", "POST"], "/api/auth/*", async (ctx) =>
		deps.auth.instance.handler(
			await platformRequest(ctx.req.raw, {
				[REQUEST_ID_HEADER]: ctx.get("requestId"),
			}),
		),
	);

	app.all("/api/*", async (ctx) => {
		const id = ctx.get("requestId");
		const req = ctx.req.raw;
		return fetchRequestHandler({
			request: withRepeatedArrayParams(await platformRequest(req)),
			contract,
			router,
			platformContext: { requestId: id, operator: ctx.get("operator") },
			options: {
				// A handler that answers outside the contract's shape is a 500
				// INTERNAL, never a body the client's types do not describe.
				responseValidation: true,
				errorHandler: (err) => {
					const cause = isRouteNotFound(err)
						? new ApiError(
								"NOT_FOUND",
								`No route for ${req.method} ${new URL(req.url).pathname}`,
							)
						: err;
					const { status, body } = toErrorEnvelope(cause, id, report);
					return TsRestResponse.fromJson(body, { status });
				},
			},
		});
	});

	// Reached by failures outside the ts-rest router: an unparseable body, a
	// refused session, or the id generator itself.
	app.onError((err, ctx) => {
		if (!ctx.req.path.startsWith("/api")) {
			report(err, UNAVAILABLE_REQUEST_ID);
			return ctx.text("Internal Server Error", 500);
		}
		const id = ctx.get("requestId");
		const { status, body } = toErrorEnvelope(err, id, report);
		ctx.header("x-request-id", id);
		return ctx.json(body, status as ContentfulStatusCode);
	});

	return app;
}

/**
 * @hono/node-server hands Hono a lightweight stand-in for Request that only
 * forwards property reads. ts-rest's request class extends the platform
 * Request and cannot wrap the stand-in, so every request through the real
 * server failed with a 500. Rebuilding from the forwarded properties gives it
 * a genuine Request under any runtime, without relying on node-server's
 * global Request override. tests/unit/server.test.ts guards this path.
 *
 * A JSON body is read and parsed here first. ts-rest parses it outside any
 * route, so an unparseable body would otherwise surface as a 500.
 */
async function platformRequest(
	raw: Request,
	setHeaders: Record<string, string> = {},
): Promise<Request> {
	const headers = new Headers(raw.headers);
	for (const [name, value] of Object.entries(setHeaders)) {
		headers.set(name, value);
	}
	const init = { method: raw.method, headers, signal: raw.signal };
	const hasBody = raw.method !== "GET" && raw.method !== "HEAD";
	if (hasBody && raw.headers.get("content-type")?.includes("json")) {
		const text = await raw.text();
		try {
			JSON.parse(text);
		} catch {
			throw new ApiError(
				"VALIDATION_FAILED",
				"The request body is not valid JSON",
			);
		}
		return new Request(raw.url, { ...init, body: text });
	}
	return new Request(raw.url, {
		...init,
		body: hasBody ? raw.body : null,
		duplex: "half",
	});
}

/**
 * ts-rest's client sends an array query param indexed (status[0]=a&status[1]=b),
 * but its server parses the query with URLSearchParams, which only collects
 * repeated keys (status=a&status=b) into arrays. An indexed key reached the
 * contract as an unknown key, was stripped, and the filter silently vanished.
 * Rewriting `name[N]=v` to repeated `name=v`, in index order, accepts both
 * forms. Only bare numeric indexes are rewritten; anything else is left as sent.
 */
function withRepeatedArrayParams(request: Request): Request {
	const url = new URL(request.url);
	const indexed: Array<{ name: string; index: number; value: string }> = [];
	const kept: Array<[string, string]> = [];
	for (const [key, value] of url.searchParams) {
		const match = /^(.+)\[(\d+)\]$/.exec(key);
		if (match?.[1] !== undefined && match[2] !== undefined) {
			indexed.push({ name: match[1], index: Number(match[2]), value });
		} else {
			kept.push([key, value]);
		}
	}
	if (indexed.length === 0) return request;
	indexed.sort((a, b) =>
		a.name === b.name ? a.index - b.index : a.name < b.name ? -1 : 1,
	);
	const params = new URLSearchParams(kept);
	for (const { name, value } of indexed) params.append(name, value);
	url.search = params.toString();
	return new Request(url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		signal: request.signal,
		duplex: "half",
	});
}
