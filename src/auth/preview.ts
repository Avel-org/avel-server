import { assertDevDatabase } from "../db/seed";
import type { IdGenerator } from "../lib/ids";
import {
	AUTH_ENV,
	type AuthConfig,
	authConfigFromEnv,
	parseWebOrigins,
} from "./config";

/**
 * DEV PREVIEW MODE: lets the operator browse a seeded local database before
 * sign-in can work. Read-only: in preview, GET and HEAD under /api/* need no
 * session, and everything else still does (src/middleware/auth.ts).
 *
 * Opt-in with AVEL_DEV_PREVIEW=1, exactly. If preview is asked for and any
 * guard fails, startup throws; it never falls back to a quieter mode.
 */
export const PREVIEW_ENV = "AVEL_DEV_PREVIEW";

export type PreviewConfig =
	| { enabled: false }
	| {
			enabled: true /** Each guard that passed, for the startup warning. */;
			guards: string[];
	  };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function refuse(reason: string): never {
	throw new Error(`${PREVIEW_ENV} refuses to start: ${reason}`);
}

export function previewConfigFromEnv(
	env: Record<string, string | undefined>,
): PreviewConfig {
	if (env[PREVIEW_ENV] !== "1") return { enabled: false };

	const nodeEnv = env.NODE_ENV;
	if (nodeEnv === "production") refuse("NODE_ENV is production");

	const url = env.DATABASE_URL;
	if (!url) refuse("DATABASE_URL is not set");
	let database: string;
	try {
		// The seed's rule, so preview and db:seed refuse exactly the same databases.
		assertDevDatabase(url);
		database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
	} catch {
		refuse("DATABASE_URL must name a database ending in _dev");
	}

	let host: string;
	try {
		host = new URL(env.BETTER_AUTH_URL ?? "").hostname;
	} catch {
		refuse("BETTER_AUTH_URL is not a URL");
	}
	if (!LOCAL_HOSTS.has(host)) {
		refuse(`BETTER_AUTH_URL host ${host} is not localhost or 127.0.0.1`);
	}

	return {
		enabled: true,
		guards: [
			`NODE_ENV is not production (${nodeEnv ?? "unset"})`,
			`database ${database} ends in _dev`,
			`BETTER_AUTH_URL host ${host} is local`,
		],
	};
}

/**
 * The auth config for a preview run. With every auth variable set, it is the
 * real one and sign-in works. With any missing (the GitHub OAuth App does not
 * exist yet), preview still starts, with sign-in switched off: a one-off
 * secret, an empty allowlist, and the GitHub endpoints disabled. `missing`
 * names what was absent, for the startup warning. A value that is present but
 * malformed still refuses startup.
 */
export function previewAuthConfig(
	env: Record<string, string | undefined>,
	ids: IdGenerator,
): { config: AuthConfig; missing: string[] } {
	const missing = Object.values(AUTH_ENV).filter((name) => !env[name]?.trim());
	if (missing.length === 0) return { config: authConfigFromEnv(env), missing };
	return {
		missing,
		config: {
			// Never used to sign a session anyone holds: sign-in is off.
			secret: `${ids.next()}${ids.next()}`,
			baseURL: (env[AUTH_ENV.baseURL] ?? "").trim(),
			github: {
				clientId: "preview-disabled",
				clientSecret: "preview-disabled",
			},
			operatorGithubIds: [],
			webOrigins: parseWebOrigins(env.AVEL_WEB_ORIGINS ?? ""),
			signInDisabled: true,
		},
	};
}
