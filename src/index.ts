import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { authConfigFromEnv } from "./auth/config";
import { signInRecorder } from "./auth/sign-in-activity";
import { sweepStuckCanonTurns } from "./db/canon";
import { getDb, useDatabaseUrl } from "./db/client";
import { dispatchByTokenSha256 } from "./db/dispatch";
import { assertRuntimeRole, runtimeDatabaseUrl } from "./db/runtime";
import * as authSchema from "./db/schema/auth";
import { localDiskBlobs } from "./gateways/blob";
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
import { DEFAULT_UPLOAD_MAX_BYTES } from "./routes/files";
import { AgentSdkHarness } from "./runner/agent-sdk-harness";
import { DEFAULT_PRICE_BOOK } from "./runner/budget";
import { type CanonModel, canonTick, offlineCanonModel } from "./runner/canon";
import { AgentSdkCanonModel } from "./runner/canon/sdk-model";
import { FakeHarness, type Harness } from "./runner/harness";
import { startRunnerLoop } from "./runner/loop";
import { applyUsage, writeDispatchStep } from "./runner/runner";

// Node does not read .env on its own; drizzle.config.ts and the seed do the
// same. loadEnvFile never overrides a variable that is already set, so real
// environment variables (CI, production) still win. Nothing above reads env at
// import time: getDb() connects lazily.
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 8787);
const logger = createLogger({ level: process.env.LOG_LEVEL });
// The server runs as avel_app (AVEL_APP_DATABASE_URL), never the owner in
// DATABASE_URL, so row-level security holds. Both refuse to start otherwise:
// unset, the owner's login, a superuser or BYPASSRLS role, or a table owner.
useDatabaseUrl(runtimeDatabaseUrl(process.env));
logger.info(
	{ role: await assertRuntimeRole(getDb()) },
	"database runtime role checked",
);
// Refuses to start on any auth variable that is missing or malformed.
const config = authConfigFromEnv(process.env);
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
// Canon's model turns run on the same opt-in: no real model without it.
// Without it, every turn answers that no model is connected, so a posted
// message still ends its turn and the sweep still runs.
let canonModel: CanonModel = offlineCanonModel();
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
	canonModel = new AgentSdkCanonModel({
		apiKey,
		configDir: path.join(path.dirname(roomsRoot), "canon-config"),
		logger,
		maxBudgetUsd: Number(process.env.AVEL_CANON_MAX_BUDGET_USD ?? 1),
		maxTurns: Number(process.env.AVEL_CANON_MAX_TURNS ?? 30),
	});
	logger.warn(
		{ model: sdkHarness.model, harness: sdkHarness.version },
		"REAL HARNESS is ON: started dispatches run a real model and spend money",
	);
} else {
	logger.warn(
		"No model is connected: dispatches run the FakeHarness and Canon answers every message with a fixed reply",
	);
}
const rooms = worktreeRooms(roomsRoot);
// The Drive's bytes: AVEL_BLOB_DIR, else beside the rooms. R2 replaces this
// in production behind the same interface (src/gateways/blob.ts).
const blobRoot =
	process.env.AVEL_BLOB_DIR || path.join(path.dirname(roomsRoot), "blobs");
const uploadMaxBytes = Number(
	process.env.AVEL_UPLOAD_MAX_BYTES || DEFAULT_UPLOAD_MAX_BYTES,
);
if (!Number.isInteger(uploadMaxBytes) || uploadMaxBytes <= 0) {
	throw new Error(
		"AVEL_UPLOAD_MAX_BYTES must be a positive whole number of bytes",
	);
}
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
	// A Connection names an env var; the gateway reads it at read time.
	repos: githubRepoSource({ env: (name) => process.env[name] }),
	templates,
	dispatchByToken: dispatchByTokenSha256,
	runnerCredentialSha256: runnerCredential,
	harness,
	prices: DEFAULT_PRICE_BOOK,
	rooms,
	roomSources,
	drive: {
		blobs: localDiskBlobs(blobRoot, randomIds),
		maxBytes: uploadMaxBytes,
	},
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
	sdkHarness.bindStepSink((id, step) =>
		writeDispatchStep(runnerDeps, id, step),
	);
	startRunnerLoop(runnerDeps, {
		intervalMs: Number(process.env.AVEL_RUNNER_INTERVAL_MS ?? 5000),
		logger,
	});
}

// Canon's turns: a posted operator message starts one; this tick answers it.
// It always runs, model or not, because nothing else ends a turn.
{
	const canonDeps = {
		db: getDb,
		clock: systemClock,
		ids: randomIds,
		prices: DEFAULT_PRICE_BOOK,
		blobs: localDiskBlobs(blobRoot, randomIds),
		model: canonModel,
		logger,
		sweepStuckTurns: sweepStuckCanonTurns,
	};
	let canonBusy = false;
	setInterval(
		async () => {
			if (canonBusy) return;
			canonBusy = true;
			try {
				const results = await canonTick(canonDeps);
				if (results.length > 0) logger.info({ results }, "canon turns ran");
			} catch (err) {
				logger.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"canon tick failed",
				);
			} finally {
				canonBusy = false;
			}
		},
		Number(process.env.AVEL_CANON_INTERVAL_MS ?? 3000),
	);
}

serve({ fetch: app.fetch, port });
logger.info(
	{ port },
	`avel-server listening on http://localhost:${port}/api/health`,
);
