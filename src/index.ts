import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { authConfigFromEnv } from "./auth/config";
import { previewAuthConfig, previewConfigFromEnv } from "./auth/preview";
import { signInRecorder } from "./auth/sign-in-activity";
import { getDb } from "./db/client";
import { dispatchByTokenSha256 } from "./db/dispatch";
import * as authSchema from "./db/schema/auth";
import { githubRepoSource } from "./gateways/repo-source";
import {
	fixtureTemplateSource,
	githubTemplateSource,
	type TemplateSource,
	unreadableTemplates,
} from "./gateways/template-source";
import { systemClock } from "./lib/clock";
import { randomIds } from "./lib/ids";
import { createLogger } from "./lib/logger";
import {
	DEV_TEMPLATE_READS,
	devTemplateFiles,
	TEMPLATE_REPOS,
} from "./lib/templates";
import { runnerCredentialSha256 } from "./lib/tokens";
import { worktreeRooms } from "./rooms/provider";
import { localSources } from "./rooms/sources";
import { DEFAULT_PRICE_BOOK } from "./runner/budget";
import { FakeHarness } from "./runner/harness";

// Node does not read .env on its own; drizzle.config.ts and the seed do the
// same. loadEnvFile never overrides a variable that is already set, so real
// environment variables (CI, production) still win. Nothing above reads env at
// import time: getDb() connects lazily.
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 8787);
const logger = createLogger({ level: process.env.LOG_LEVEL });
// Dev preview: refuses to start unless every guard holds (src/auth/preview.ts).
const preview = previewConfigFromEnv(process.env);
const { config, missing } = preview.enabled
	? previewAuthConfig(process.env, randomIds)
	: { config: authConfigFromEnv(process.env), missing: [] };
if (preview.enabled) {
	logger.warn(
		{ guards: preview.guards, signInDisabled: missing.length > 0, missing },
		"DEV PREVIEW is ON: GET and HEAD under /api/* need no session; every other method still does. Local only.",
	);
}
// Template repositories: GitHub when a credential is configured. Without
// one, dev reads the fixture; production reads nothing, so every row shows
// unreadable rather than made-up data.
const templateOwner = process.env.AVEL_TEMPLATE_OWNER;
const templateToken = process.env.AVEL_TEMPLATE_GITHUB_TOKEN;
let templates: TemplateSource;
if (templateOwner && templateToken) {
	templates = githubTemplateSource({
		slugs: TEMPLATE_REPOS,
		owner: templateOwner,
		token: templateToken,
		onError: (slug, err) =>
			logger.warn({ slug, err }, "template repository unreadable"),
	});
} else if (process.env.NODE_ENV === "production") {
	logger.warn(
		"AVEL_TEMPLATE_OWNER or AVEL_TEMPLATE_GITHUB_TOKEN is not set: every template reads as unreadable",
	);
	templates = unreadableTemplates(TEMPLATE_REPOS);
} else {
	templates = fixtureTemplateSource(
		TEMPLATE_REPOS,
		DEV_TEMPLATE_READS,
		devTemplateFiles(),
	);
}

// Tier 0 rooms are worktrees under %LOCALAPPDATA%\avel\rooms (J, 2026-10-13);
// elsewhere, under the user's local share directory.
const roomsRoot = path.join(
	process.env.LOCALAPPDATA ?? path.join(homedir(), ".local", "share"),
	"avel",
	"rooms",
);

// Throws, so the server refuses to start, on a short or unprefixed credential.
const runnerCredential = runnerCredentialSha256(
	process.env.AVEL_RUNNER_CREDENTIAL,
);

const auth = createAuth({
	config,
	database: drizzleAdapter(getDb(), { provider: "pg", schema: authSchema }),
	ids: randomIds,
	logger,
	recordSignIn: signInRecorder({
		db: getDb,
		clock: systemClock,
		ids: randomIds,
	}),
});

serve({
	fetch: createApp({
		clock: systemClock,
		ids: randomIds,
		logger,
		auth,
		db: getDb,
		webOrigins: config.webOrigins,
		preview: preview.enabled,
		// A Connection names an env var; the gateway reads it at read time.
		repos: githubRepoSource({ env: (name) => process.env[name] }),
		templates,
		dispatchByToken: dispatchByTokenSha256,
		runnerCredentialSha256: runnerCredential,
		// No real model yet. Nothing ticks the runner in this process: a
		// later step wires the runner process (src/runner/runner.ts).
		harness: new FakeHarness(),
		prices: DEFAULT_PRICE_BOOK,
		rooms: worktreeRooms(roomsRoot),
		// Local clones only; unset, every start refuses source_unavailable.
		roomSources: localSources(process.env.AVEL_SOURCES_DIR || undefined),
	}).fetch,
	port,
});
logger.info(
	{ port },
	`avel-server listening on http://localhost:${port}/api/health`,
);
