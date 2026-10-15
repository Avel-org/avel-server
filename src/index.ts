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
import { AgentSdkHarness } from "./runner/agent-sdk-harness";
import { DEFAULT_PRICE_BOOK } from "./runner/budget";
import { FakeHarness, type Harness } from "./runner/harness";
import { startRunnerLoop } from "./runner/loop";
import { applyUsage } from "./runner/runner";

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

// The harness (step 9d). The FakeHarness unless AVEL_HARNESS=agent-sdk,
// which runs real agents on the Claude Agent SDK and spends real money; it
// refuses to start without ANTHROPIC_API_KEY. The key is taken out of
// process.env once read, so no other child process (git) inherits it.
const realHarness = process.env.AVEL_HARNESS === "agent-sdk";
let harness: Harness = new FakeHarness();
let sdkHarness: AgentSdkHarness | null = null;
if (realHarness) {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error("AVEL_HARNESS=agent-sdk needs ANTHROPIC_API_KEY");
	}
	delete process.env.ANTHROPIC_API_KEY;
	sdkHarness = new AgentSdkHarness({
		model: process.env.AVEL_HARNESS_MODEL || "claude-sonnet-5-5",
		apiKey,
		configDir: path.join(path.dirname(roomsRoot), "runner-config"),
		ids: randomIds,
		logger,
		maxBudgetUsd: Number(process.env.AVEL_HARNESS_MAX_BUDGET_USD ?? 2),
		maxTurns: Number(process.env.AVEL_HARNESS_MAX_TURNS ?? 60),
	});
	harness = sdkHarness;
	logger.warn(
		{ model: sdkHarness.model, harness: sdkHarness.version },
		"REAL HARNESS is ON: started dispatches run a real model and spend money",
	);
}
const rooms = worktreeRooms(roomsRoot);
// Local clones only; unset, every start refuses source_unavailable.
const roomSources = localSources(process.env.AVEL_SOURCES_DIR || undefined);

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

const app = createApp({
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
	harness,
	prices: DEFAULT_PRICE_BOOK,
	rooms,
	roomSources,
});

// The real harness files reports and findings through the app itself, in
// process, and the runner ticks here. With the FakeHarness nothing ticks.
if (sdkHarness) {
	sdkHarness.bindAgentApi((request) => Promise.resolve(app.fetch(request)));
	const runnerDeps = {
		db: getDb,
		clock: systemClock,
		ids: randomIds,
		harness: sdkHarness,
		prices: DEFAULT_PRICE_BOOK,
		rooms,
		roomSources,
	};
	sdkHarness.bindUsageSink((id, split) => applyUsage(runnerDeps, id, split));
	startRunnerLoop(runnerDeps, {
		intervalMs: Number(process.env.AVEL_RUNNER_INTERVAL_MS ?? 5000),
		logger,
	});
}

serve({ fetch: app.fetch, port });
logger.info(
	{ port },
	`avel-server listening on http://localhost:${port}/api/health`,
);
