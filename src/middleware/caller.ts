import type { AppRouter } from "@ts-rest/core";
import type { MiddlewareHandler } from "hono";
import type { Auth, Operator } from "../auth";
import type { BriefRef, DispatchStatus, Role } from "../contract";
import type { Executor } from "../db/tx";
import { agentMay } from "../lib/families";
import { RUNNER_CREDENTIAL_PREFIX, sameSha256, sha256Hex } from "../lib/tokens";
import { type AuthVariables, isPublicPath, requireOperator } from "./auth";
import { ApiError } from "./errors";
import { routeMatcher } from "./route-access";

/**
 * What a dispatch token resolves to. The fields the middleware and the
 * agent routes read; src/db/dispatch.ts's row types satisfy it.
 */
export type DispatchTokenMatch = {
	dispatch: {
		id: string;
		rosterEntryId: string;
		missionId: string | null;
		status: DispatchStatus;
		briefRef: BriefRef | null;
	};
	rosterEntry: {
		id: string;
		missionId: string | null;
		agentTemplateId: string;
	};
	/** The roster entry's template's roles. */
	roles: readonly Role[];
};

/** Finds the dispatch whose token_sha256 is `sha256`, whatever its status. */
export type DispatchTokenLookup = (
	exec: Executor,
	sha256: string,
) => Promise<DispatchTokenMatch | null>;

/** Until module 6's lookup is wired: no token matches, so every agent is refused. */
export const noDispatches: DispatchTokenLookup = async () => null;

export type OperatorCaller = { kind: "operator"; operator: Operator };
export type AgentCaller = { kind: "agent" } & DispatchTokenMatch;
export type SystemCaller = { kind: "system" };

/** Who a request is from (DATA-CONTRACTS-V2.md, Dispatch: three callers, one middleware). */
export type Caller = OperatorCaller | AgentCaller | SystemCaller;

/** Unset on public paths and on a dev-preview read with no session. */
export type CallerVariables = AuthVariables & { caller?: Caller };

export type CallerDeps = {
	auth: Auth;
	preview: boolean;
	db: () => Executor;
	contract: AppRouter;
	dispatchByToken: DispatchTokenLookup;
	/** The runner credential's hex SHA-256; null when no runner is configured. */
	runnerCredentialSha256: string | null;
};

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * Resolves every /api/* request to a caller.
 *
 * - No bearer: requireOperator, unchanged (401 before 404, the allowlist,
 *   dev preview), and an operator caller when it set one.
 * - `Bearer avl_run_…`: the runner when it matches the configured
 *   credential, else 401 UNAUTHENTICATED. The runner reaches only routes
 *   declaring `system: true`; any other answers 403 FORBIDDEN.
 * - Any other bearer: a dispatch token. Not found or not running is 401
 *   DISPATCH_CLOSED, before the route is looked at, so a dead token cannot
 *   map routes. A route without an agent declaration, or one the agent's
 *   families do not allow, is 403 AGENT_NOT_PERMITTED.
 *
 * Operator-only actions carry no declaration, so nothing here can grant
 * them to an agent or the runner.
 */
export function resolveCaller(
	deps: CallerDeps,
): MiddlewareHandler<{ Variables: CallerVariables }> {
	const operatorGate = requireOperator(deps.auth, { preview: deps.preview });
	const routeAt = routeMatcher(deps.contract);
	return async (ctx, next) => {
		if (isPublicPath(ctx.req.path)) return next();
		const bearer = BEARER.exec(ctx.req.header("authorization") ?? "")?.[1];
		if (bearer === undefined) {
			return operatorGate(ctx, async () => {
				const operator = ctx.get("operator");
				if (operator) ctx.set("caller", { kind: "operator", operator });
				await next();
			});
		}

		const sha256 = sha256Hex(bearer);
		if (bearer.startsWith(RUNNER_CREDENTIAL_PREFIX)) {
			const expected = deps.runnerCredentialSha256;
			if (!expected || !sameSha256(sha256, expected)) {
				throw new ApiError("UNAUTHENTICATED", "Unknown runner credential");
			}
			if (!routeAt(ctx.req.method, ctx.req.path)?.access.system) {
				throw new ApiError("FORBIDDEN", "The runner may not call this route");
			}
			ctx.set("caller", { kind: "system" });
			return next();
		}

		const match = await deps.dispatchByToken(deps.db(), sha256);
		if (!match || match.dispatch.status !== "running") {
			throw new ApiError(
				"DISPATCH_CLOSED",
				"This token's dispatch is not running",
			);
		}
		const declared = routeAt(ctx.req.method, ctx.req.path)?.access.agent;
		if (!declared || !agentMay(match.roles, declared)) {
			throw new ApiError(
				"AGENT_NOT_PERMITTED",
				"This agent may not call this route",
			);
		}
		ctx.set("caller", { kind: "agent", ...match });
		return next();
	};
}
