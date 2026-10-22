/**
 * Sign-in configuration, read from the environment once at startup by
 * src/index.ts. Tests build an AuthConfig directly and need no credentials.
 */
export type AuthConfig = {
	/** Signs session cookies and encrypts stored OAuth tokens. At least 32 characters. */
	secret: string;
	/** The server's public origin, for example http://localhost:8787. */
	baseURL: string;
	github: { clientId: string; clientSecret: string };
	/** GitHub numeric user ids allowed to sign in. Everyone else is refused. */
	operatorGithubIds: readonly string[];
	/**
	 * Other origins allowed to call the API with credentials: avel-web, and
	 * the Tauri desktop and mobile builds. Exact matches only. Empty means
	 * same-origin only.
	 */
	webOrigins: readonly string[];
};

export const AUTH_ENV = {
	secret: "BETTER_AUTH_SECRET",
	baseURL: "BETTER_AUTH_URL",
	githubClientId: "GITHUB_CLIENT_ID",
	githubClientSecret: "GITHUB_CLIENT_SECRET",
	operators: "AVEL_OPERATOR_GITHUB_IDS",
} as const;

/** Optional, so it is not in AUTH_ENV's required list. */
export const WEB_ORIGINS_ENV = "AVEL_WEB_ORIGINS";

/**
 * Parses the auth variables, and refuses to start on any that are missing
 * or malformed. An empty allowlist is refused too: it would start a server
 * nobody can sign in to, which is a misconfiguration, not a policy.
 */
export function authConfigFromEnv(
	env: Record<string, string | undefined>,
): AuthConfig {
	const missing = Object.values(AUTH_ENV).filter((name) => !env[name]?.trim());
	if (missing.length > 0) {
		throw new Error(
			`Missing auth environment variables: ${missing.join(", ")}`,
		);
	}
	const read = (name: string) => (env[name] ?? "").trim();

	const secret = read(AUTH_ENV.secret);
	if (secret.length < 32) {
		throw new Error(`${AUTH_ENV.secret} must be at least 32 characters`);
	}

	return {
		secret,
		baseURL: read(AUTH_ENV.baseURL),
		github: {
			clientId: read(AUTH_ENV.githubClientId),
			clientSecret: read(AUTH_ENV.githubClientSecret),
		},
		operatorGithubIds: parseOperatorIds(read(AUTH_ENV.operators)),
		webOrigins: parseWebOrigins(env[WEB_ORIGINS_ENV] ?? ""),
	};
}

/**
 * "https://app.avel.dev, tauri://localhost" → both, exactly. Each entry must
 * be a bare origin, scheme://host[:port]: no path, no trailing slash, and no
 * wildcard, because a pattern here would hand credentials to every match.
 * Non-http schemes are allowed for the Tauri builds.
 */
export function parseWebOrigins(raw: string): string[] {
	const origins = raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const bad = origins.filter(
		(o) => !/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o),
	);
	if (bad.length > 0) {
		throw new Error(
			`${WEB_ORIGINS_ENV} holds exact origins like https://app.example.com, with no path or wildcard: ${bad.join(", ")}`,
		);
	}
	return origins;
}

/** "123, 456" → ["123", "456"]. GitHub user ids are numeric; anything else is refused. */
export function parseOperatorIds(raw: string): string[] {
	const ids = raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const bad = ids.filter((part) => !/^\d+$/.test(part));
	if (bad.length > 0) {
		throw new Error(
			`${AUTH_ENV.operators} holds GitHub numeric user ids, not logins: ${bad.join(", ")}`,
		);
	}
	if (ids.length === 0) {
		throw new Error(`${AUTH_ENV.operators} is empty, so nobody could sign in`);
	}
	return ids;
}
