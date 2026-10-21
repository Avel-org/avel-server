import {
	type BetterAuthOptions,
	type BetterAuthPlugin,
	betterAuth,
} from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { IdGenerator } from "../lib/ids";
import type { Logger } from "../lib/logger";
import { UNAVAILABLE_REQUEST_ID } from "../middleware/errors";
import type { AuthConfig } from "./config";

/**
 * Better Auth endpoints that are switched off. Sign-in is GitHub only, so
 * the password and email flows go; the user and account editors go, because
 * they would let a client rewrite githubId or link another identity; and the
 * token endpoints go, because they hand the stored GitHub token to a browser.
 * What remains: sign-in/social, callback, get-session, sign-out, and the
 * session list and revoke endpoints.
 */
export const DISABLED_PATHS = [
	"/sign-up/email",
	"/sign-in/email",
	"/change-email",
	"/change-password",
	"/request-password-reset",
	"/reset-password",
	"/send-verification-email",
	"/verify-email",
	"/verify-password",
	"/update-user",
	"/update-session",
	"/delete-user",
	"/delete-user/callback",
	"/link-social",
	"/unlink-account",
	"/list-accounts",
	"/account-info",
	"/get-access-token",
	"/refresh-token",
];

/**
 * Endpoints with a route parameter. disabledPaths compares the request path
 * by exact string, so it can never match these; a before-hook refuses them
 * by route pattern instead. tests/unit/auth-disabled-paths.test.ts proves
 * every entry in both lists with a real request.
 */
export const DISABLED_ROUTES = ["/reset-password/:token"];

export type AuthDeps = {
	config: AuthConfig;
	/** drizzleAdapter over src/db/schema/auth.ts in production; memoryAdapter in unit tests. */
	database: BetterAuthOptions["database"];
	ids: IdGenerator;
	logger: Logger;
	/**
	 * Writes the auth.signed_in ActivityLog row. Called after Better Auth
	 * commits the session; if it throws, that session is deleted.
	 */
	recordSignIn: (entry: { userId: string; requestId: string }) => Promise<void>;
	plugins?: BetterAuthPlugin[];
};

/**
 * Set by src/app.ts on every request it hands Better Auth, overwriting any
 * value the client sent, so the sign-in hook can log the request's id.
 */
export const REQUEST_ID_HEADER = "x-avel-request-id";

/** The signed-in operator, as handlers see it. */
export type Operator = {
	id: string;
	githubId: string;
	githubLogin: string;
	name: string;
	email: string;
};

/**
 * Operator sign-in: GitHub OAuth through Better Auth, limited to the GitHub
 * ids in the allowlist.
 *
 * The allowlist is checked at three points, so no single hook is load-bearing:
 * before a user row is created, before any session is created, and on every
 * request by src/middleware/auth.ts. Removing an id from the allowlist locks
 * that operator out on their next request, without waiting for the session
 * to expire.
 *
 * Better Auth stamps createdAt, updatedAt and expiresAt from its own clock,
 * not the injected one. Ids come from the injected IdGenerator.
 */
export function createAuth(deps: AuthDeps) {
	const operators = new Set(deps.config.operatorGithubIds);
	const trustedOrigins = [
		new URL(deps.config.baseURL).origin,
		...deps.config.webOrigins,
	];
	const isOperator = (githubId: unknown): boolean =>
		typeof githubId === "string" && operators.has(githubId);

	const instance = betterAuth({
		secret: deps.config.secret,
		baseURL: deps.config.baseURL,
		// BETTER_AUTH_URL is the APP's origin: the browser reaches this server
		// through the app's same-origin proxy, so callbacks and cookies are
		// built from it, never from the proxied Host header.
		basePath: "/api/auth",
		trustedOrigins,
		database: deps.database,
		plugins: deps.plugins ?? [],
		logger: {
			log: (level, message, ...args) =>
				deps.logger[level]({ source: "better-auth", args }, message),
		},
		advanced: {
			database: { generateId: () => deps.ids.next() },
		},
		emailAndPassword: { enabled: false },
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (DISABLED_ROUTES.includes(ctx.path)) {
					throw new APIError("NOT_FOUND", { message: "Not Found" });
				}
			}),
		},
		disabledPaths: DISABLED_PATHS,
		user: {
			// Set from GitHub's profile by mapProfileToUser. Better Auth drops
			// `input: false` fields from a provider profile too, so these are
			// input fields, and every endpoint that takes user input is in
			// DISABLED_PATHS, which leaves GitHub's profile as their only writer.
			additionalFields: {
				githubId: { type: "string", required: true, unique: true },
				githubLogin: { type: "string", required: true },
			},
		},
		account: {
			encryptOAuthTokens: true,
			accountLinking: { enabled: false },
		},
		socialProviders: {
			github: {
				clientId: deps.config.github.clientId,
				clientSecret: deps.config.github.clientSecret,
				overrideUserInfoOnSignIn: true,
				mapProfileToUser: (profile) => ({
					githubId: String(profile.id),
					githubLogin: profile.login,
				}),
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						if (isOperator(user.githubId)) return;
						deps.logger.warn(
							{ githubId: user.githubId, githubLogin: user.githubLogin },
							"sign-in refused: not on the operator allowlist",
						);
						return false;
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						const ctx = await instance.$context;
						const owner = await ctx.internalAdapter.findUserById(
							session.userId,
						);
						if (
							!owner ||
							!isOperator((owner as { githubId?: unknown }).githubId)
						) {
							deps.logger.warn(
								{ userId: session.userId },
								"session refused: user is not on the operator allowlist",
							);
							return false;
						}
					},
					// auth.signed_in is a documented exception to "the log row shares
					// the mutation's transaction": Better Auth owns the session insert
					// and we cannot join its transaction. Written after it commits, so
					// a session insert that fails leaves no log row. If the log insert
					// fails, the session is deleted and the error goes on, so the
					// callback fails and its cookie is never sent. The remaining gap is
					// a session row whose delete also failed, with no cookie anywhere.
					after: async (session, endpoint) => {
						try {
							await deps.recordSignIn({
								userId: session.userId,
								requestId:
									endpoint?.request?.headers.get(REQUEST_ID_HEADER) ??
									endpoint?.headers?.get(REQUEST_ID_HEADER) ??
									UNAVAILABLE_REQUEST_ID,
							});
						} catch (err) {
							const ctx = await instance.$context;
							await ctx.internalAdapter
								.deleteSession(session.token)
								.catch((deleteErr: unknown) =>
									deps.logger.error(
										{ err: deleteErr, userId: session.userId },
										"sign-in log failed and its session could not be deleted",
									),
								);
							throw err;
						}
					},
				},
			},
		},
	});

	/**
	 * The operator behind a request's session cookie, or why there is none.
	 *
	 * getSession slides the session once its updateAge has passed: it extends
	 * expiresAt in the database and sets a fresh cookie. `setCookies` carries
	 * that cookie, and the caller must put it on its response; dropping it
	 * leaves the browser's cookie to die at its original expiry while the row
	 * lives on, which signs out a daily-active operator after a week.
	 */
	async function operatorFor(
		headers: Headers,
	): Promise<
		| { operator: Operator; setCookies: string[] }
		| { refused: "no_session" | "not_operator" }
	> {
		const { response: found, headers: responseHeaders } =
			await instance.api.getSession({ headers, returnHeaders: true });
		if (!found) return { refused: "no_session" };
		const { id, githubId, githubLogin, name, email } = found.user;
		if (!isOperator(githubId)) return { refused: "not_operator" };
		return {
			operator: { id, githubId, githubLogin, name, email },
			setCookies: responseHeaders?.getSetCookie() ?? [],
		};
	}

	return { instance, operatorFor, isOperator, trustedOrigins };
}

export type Auth = ReturnType<typeof createAuth>;
