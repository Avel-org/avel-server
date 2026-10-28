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
import type { CheckRunner } from "./gateways/check-runner";
import type { RepoSource } from "./gateways/repo-source";
import type { RepoWriter } from "./gateways/repo-writer";
import type { TemplateSource } from "./gateways/template-source";
import type { Clock } from "./lib/clock";
import type { IdGenerator } from "./lib/ids";
import type { Logger } from "./lib/logger";
import { requireTrustedOrigin } from "./middleware/auth";
import { limitBody } from "./middleware/body-limit";
import {
	type CallerVariables,
	type DispatchTokenLookup,
	resolveCaller,
} from "./middleware/caller";
import { corsFor } from "./middleware/cors";
import {
	ApiError,
	isRouteNotFound,
	loggerReporter,
	toErrorEnvelope,
	UNAVAILABLE_REQUEST_ID,
} from "./middleware/errors";
import { requestId } from "./middleware/request-id";
import type { RoomProvider } from "./rooms/provider";
import type { RoomSourceResolver } from "./rooms/sources";
import { activityRoutes } from "./routes/activity";
import { agentRoutes } from "./routes/agent";
import {
	agentTemplateRoutes,
	identityVersionRoutes,
} from "./routes/agent-templates";
import { canonRoutes } from "./routes/canon";
import { clientRoutes } from "./routes/clients";
import { connectionRoutes } from "./routes/connections";
import { dispatchRoutes } from "./routes/dispatches";
import { engagementRoutes } from "./routes/engagements";
import { exportZipRoute } from "./routes/export-zip";
import { exportRoutes } from "./routes/exports";
import { type Drive, fileRoutes, intakeFileRoutes } from "./routes/files";
import { findingRoutes } from "./routes/findings";
import { gateRoutes } from "./routes/gate";
import { githubWebhookRoute } from "./routes/github-webhook";
import { health } from "./routes/health";
import { intakeRoutes } from "./routes/intake";
import { missionLifecycleRoutes } from "./routes/mission-lifecycle";
import { missionPlanRoutes } from "./routes/mission-plan";
import { missionRoutes } from "./routes/missions";
import { playbookRoutes } from "./routes/playbooks";
import { presetRoutes } from "./routes/presets";
import { proposalRoutes } from "./routes/proposals";
import { repoPolicyRoutes } from "./routes/repo-policies";
import { rosterRoutes } from "./routes/roster";
import type { RequestContext } from "./routes/shared";
import { skillSourceRoutes } from "./routes/skill-sources";
import { skillRoutes } from "./routes/skills";
import { templateCover, templateRoutes } from "./routes/templates";
import type { PriceBook } from "./runner/budget";
import type { Harness } from "./runner/harness";

export type AppDeps = {
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	auth: Auth;
	/** The pool in production. Tests pass an open transaction they roll back. */
	db: () => Executor;
	/** Origins allowed credentialed CORS (the Tauri builds). Empty means none. */
	webOrigins: readonly string[];
	/** Where the repo read gets repositories (src/gateways/repo-source.ts). GitHub in production, fixtures in tests. */
	repos: RepoSource;
	/** Where exports write to GitHub (src/gateways/repo-writer.ts): a pull request per github_pr export. GitHub in production, a recording fake in tests. */
	repoWriter: RepoWriter;
	/** Where the template route reads template repositories (src/gateways/template-source.ts). GitHub in production, a fixture in dev and tests. */
	templates: TemplateSource;
	/** Resolves an agent's bearer token to its dispatch (src/middleware/caller.ts). */
	dispatchByToken: DispatchTokenLookup;
	/** The runner credential's hex SHA-256; null when no runner is configured, so no request is the runner. */
	runnerCredentialSha256: string | null;
	/** What runs an agent's model (src/runner/harness.ts). The FakeHarness until a real one is wired. */
	harness: Harness;
	/** Price tables by version, and the one a new dispatch starts under (src/runner/budget.ts). */
	prices: PriceBook;
	/** Where dispatches get their rooms (src/rooms/provider.ts). Worktrees under %LOCALAPPDATA%\avel\rooms in production, a temp dir in tests. */
	rooms: RoomProvider;
	/** Where a room's source clone is found (src/rooms/sources.ts). AVEL_SOURCES_DIR in production. */
	roomSources: RoomSourceResolver;
	/** The Drive's blob store and upload cap (src/routes/files.ts). Local disk in dev, memory or a temp dir in tests. */
	drive: Drive;
	/** Runs the gate's test, typecheck and command checks (src/gateways/check-runner.ts). Null until a runner is installed: those checks report not_run. */
	checkRunner: CheckRunner | null;
	/** The secret GitHub signs webhook deliveries with (GITHUB_WEBHOOK_SECRET). Null: POST /api/webhooks/github does not exist. */
	githubWebhookSecret: string | null;
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
	const runnerDeps = {
		...routeDeps,
		harness: deps.harness,
		prices: deps.prices,
		rooms: deps.rooms,
		roomSources: deps.roomSources,
	};
	const router = tsr.platformContext<RequestContext>().router(contract, {
		health: health(deps.clock),
		clients: clientRoutes(routeDeps),
		engagements: engagementRoutes(routeDeps),
		missions: missionRoutes(routeDeps),
		missionPlans: missionPlanRoutes(routeDeps),
		missionLifecycle: missionLifecycleRoutes(runnerDeps),
		dispatches: dispatchRoutes(runnerDeps),
		activity: activityRoutes(routeDeps),
		intakes: intakeRoutes({ ...routeDeps, repos: deps.repos }),
		intakeFiles: intakeFileRoutes(routeDeps),
		findings: findingRoutes(routeDeps),
		gate: gateRoutes({
			...routeDeps,
			roomSources: deps.roomSources,
			checkRunner: deps.checkRunner,
		}),
		exports: exportRoutes({
			...routeDeps,
			repos: deps.repos,
			repoWriter: deps.repoWriter,
			roomSources: deps.roomSources,
		}),
		connections: connectionRoutes(routeDeps),
		repoPolicies: repoPolicyRoutes(routeDeps),
		proposals: proposalRoutes(routeDeps),
		agentTemplates: agentTemplateRoutes(routeDeps),
		identityVersions: identityVersionRoutes(routeDeps),
		skills: skillRoutes(routeDeps),
		skillSources: skillSourceRoutes(routeDeps),
		roster: rosterRoutes(routeDeps),
		presets: presetRoutes(routeDeps),
		playbooks: playbookRoutes(routeDeps),
		templates: templateRoutes({ ...routeDeps, templates: deps.templates }),
		agent: agentRoutes(runnerDeps),
		canon: canonRoutes(runnerDeps),
	});

	const app = new Hono<{ Variables: CallerVariables }>();

	// First, so a preflight is answered before auth can refuse it.
	app.use("/api/*", corsFor(deps.webOrigins));
	app.use("/api/*", requestId(deps.ids));
	// After the request id, so a refusal carries one; before anything reads a body.
	app.use("/api/*", limitBody());
	// After the request id, so a refusal still carries one. A request without
	// a bearer token goes through requireOperator unchanged.
	app.use(
		"/api/*",
		resolveCaller({
			auth: deps.auth,
			db: deps.db,
			contract,
			dispatchByToken: deps.dispatchByToken,
			runnerCredentialSha256: deps.runnerCredentialSha256,
		}),
	);

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

	// An image, not an envelope, so it sits outside the contract router.
	app.get("/api/templates/:slug/cover", templateCover(deps.templates));

	// Bytes, not envelopes, so the Drive's byte routes sit outside it too.
	const files = fileRoutes({
		...routeDeps,
		drive: deps.drive,
		trustedOrigins: deps.auth.trustedOrigins,
	});
	app.post("/api/intakes/:intakeId/files", files.upload);
	app.get("/api/intakes/:intakeId/files/:fileId/content", files.download);
	app.delete("/api/intakes/:intakeId/files/:fileId", files.purge);

	// A done zip export's bytes, rendered again on each request.
	app.get(
		"/api/exports/:id/zip",
		exportZipRoute({
			...routeDeps,
			repos: deps.repos,
			repoWriter: deps.repoWriter,
			roomSources: deps.roomSources,
		}),
	);

	// GitHub's deliveries: signed, not enveloped, and no session reaches them.
	app.post(
		"/api/webhooks/github",
		githubWebhookRoute({ ...routeDeps, secret: deps.githubWebhookSecret }),
	);

	app.all("/api/*", async (ctx) => {
		const id = ctx.get("requestId");
		const req = ctx.req.raw;
		return fetchRequestHandler({
			request: withRepeatedArrayParams(await platformRequest(req)),
			contract,
			router,
			platformContext: {
				requestId: id,
				operator: ctx.get("operator"),
				caller: ctx.get("caller"),
			},
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
