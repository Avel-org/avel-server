import { Writable } from "node:stream";
import { memoryAdapter } from "better-auth/adapters/memory";
import { vi } from "vitest";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import type { AuthConfig } from "../../src/auth/config";
import { noTemplates } from "../../src/gateways/template-source";
import { type Clock, fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";
import { createLogger } from "../../src/lib/logger";
import { noDispatches } from "../../src/middleware/caller";
import { noRepos } from "./repo-fixtures";

// Helpers shared by the unit tests. Not collected as a test file: vitest only
// collects *.test.ts.

/**
 * BETTER_AUTH_URL in tests: the app origin the browser sees. app.request()
 * arrives at http://localhost, as a request through the app's proxy would
 * arrive at a different host than the one the browser used.
 */
export const BASE_URL = "http://localhost:3000";

export const TAURI_ORIGIN = "tauri://localhost";

export const OPERATOR = {
	id: 1001,
	login: "operator",
	email: "operator@example.com",
	name: "The Operator",
};

export const STRANGER = {
	id: 2002,
	login: "stranger",
	email: "stranger@example.com",
	name: "A Stranger",
};

export function testAuthConfig(
	operatorGithubIds: string[],
	webOrigins: string[] = [TAURI_ORIGIN],
): AuthConfig {
	return {
		secret: "test-secret-that-is-at-least-32-characters-long",
		baseURL: BASE_URL,
		github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
		operatorGithubIds,
		webOrigins,
	};
}

/** A pino logger whose lines are parsed into `lines` instead of written anywhere. */
export function captureLogger() {
	const lines: Array<Record<string, unknown>> = [];
	const destination = new Writable({
		write(chunk, _encoding, done) {
			for (const line of String(chunk).split("\n")) {
				if (line.trim()) lines.push(JSON.parse(line));
			}
			done();
		},
	});
	return { logger: createLogger({ level: "debug", destination }), lines };
}

/**
 * The app with in-memory auth. The auth instance gets its own id generator,
 * so request ids stay predictable whatever auth does inside a request.
 */
export function buildApp(
	options: {
		clock?: Clock;
		ids?: IdGenerator;
		operators?: string[];
		/** Dev preview on. */
		preview?: boolean;
		/** Preview started without GitHub credentials: sign-in endpoints off. */
		signInDisabled?: boolean;
		/** Replaces the fake auth.signed_in recorder, for example with one that throws. */
		recordSignIn?: (entry: SignIn) => Promise<void>;
	} = {},
) {
	const signIns: SignIn[] = [];
	const { logger, lines } = captureLogger();
	const memory = {
		user: [],
		session: [],
		account: [],
		verification: [],
	} as Record<string, Array<Record<string, unknown>>>;
	const config = {
		...testAuthConfig(options.operators ?? [String(OPERATOR.id)]),
		...(options.signInDisabled ? { signInDisabled: true as const } : {}),
	};
	const auth = createAuth({
		config,
		database: memoryAdapter(memory),
		ids: sequentialIds(),
		logger,
		recordSignIn:
			options.recordSignIn ??
			(async (entry) => {
				signIns.push(entry);
			}),
	});
	const app = createApp({
		clock: options.clock ?? fixedClock("2026-10-03T12:00:00.000Z"),
		ids: options.ids ?? sequentialIds(),
		logger,
		auth,
		// Unit tests reach no database route. A test that does fails loudly.
		db: () => {
			throw new Error("unit tests have no database; use tests/api");
		},
		webOrigins: config.webOrigins,
		preview: options.preview ?? false,
		repos: noRepos,
		templates: noTemplates,
		dispatchByToken: noDispatches,
		runnerCredentialSha256: null,
	});
	return { app, auth, memory, logs: lines, signIns };
}

type Profile = typeof OPERATOR;

type SignIn = { userId: string; requestId: string };

/**
 * Answers GitHub's three OAuth calls (token exchange, user, emails) for
 * `profile`, and passes every other request through. Restore with
 * `vi.restoreAllMocks()`.
 */
export function mockGitHub(profile: Profile) {
	const real = globalThis.fetch;
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (url.startsWith("https://github.com/login/oauth/access_token")) {
				return Response.json({
					access_token: "gho_test_token",
					token_type: "bearer",
					scope: "read:user,user:email",
				});
			}
			if (url === "https://api.github.com/user") {
				return Response.json({
					id: profile.id,
					login: profile.login,
					name: profile.name,
					email: profile.email,
					avatar_url: "https://avatars.example.com/u/1",
				});
			}
			if (url === "https://api.github.com/user/emails") {
				return Response.json([
					{
						email: profile.email,
						primary: true,
						verified: true,
						visibility: "private",
					},
				]);
			}
			return real(input, init);
		});
}

function cookiesFrom(res: Response): string[] {
	return res.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");
}

/**
 * Runs the real sign-in flow through the app: start the GitHub sign-in, then
 * hit the OAuth callback with the state Better Auth issued. Only GitHub is
 * mocked. Returns the session cookie when sign-in succeeded.
 */
export async function signInWithGitHub(
	app: ReturnType<typeof createApp>,
	profile: Profile,
	extraHeaders: Record<string, string> = {},
) {
	mockGitHub(profile);
	try {
		const start = await app.request("/api/auth/sign-in/social", {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({ provider: "github", callbackURL: "/" }),
		});
		if (start.status !== 200) {
			throw new Error(
				`sign-in start answered ${start.status}: ${await start.text()}`,
			);
		}
		const { url } = (await start.json()) as { url: string };
		const state = new URL(url).searchParams.get("state");
		const callback = await app.request(
			`/api/auth/callback/github?code=test-code&state=${state}`,
			{ headers: { ...extraHeaders, cookie: cookiesFrom(start).join("; ") } },
		);
		const session = cookiesFrom(callback).find((c) =>
			c.includes("session_token="),
		);
		return {
			status: callback.status,
			location: callback.headers.get("location"),
			cookie: session ?? null,
		};
	} finally {
		vi.restoreAllMocks();
	}
}
