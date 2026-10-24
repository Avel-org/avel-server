import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { authConfigFromEnv } from "./auth/config";
import { signInRecorder } from "./auth/sign-in-activity";
import { ORPHAN_SWEEP_INTERVAL_MS } from "./db/blob-sweep";
import { sweepStuckCanonTurns } from "./db/canon";
import { closeDb, getDb, useDatabaseUrl } from "./db/client";
import { dispatchByTokenSha256 } from "./db/dispatch";
import { assertRuntimeRole, runtimeDatabaseUrl } from "./db/runtime";
import * as authSchema from "./db/schema/auth";
import { localDiskBlobs } from "./gateways/blob";
import { dockerAgentRooms } from "./gateways/docker-agent-rooms";
import { dockerCheckRunner } from "./gateways/docker-check-runner";
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
import { DEFAULT_PRICE_BOOK } from "./runner/budget";
import {
	intervalFromEnv,
	type StopLoop,
	startBlobSweepLoop,
	startCanonLoop,
	startGateJobLoop,
} from "./runner/loop";
import { harnessFromEnv, shutdown, startRealRunner } from "./runner/wiring";

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

// The gate's check runner on local Docker. Unset, the gate reports test,
// typecheck and command checks not_run. Throws, so the server refuses to
// start, on an image not pinned by digest. The agents' run_checks uses
// the same runner, as advice.
const checkImage = process.env.AVEL_CHECK_IMAGE || undefined;
const checkRunner = checkImage
	? dockerCheckRunner({ image: checkImage, ids: randomIds })
	: null;
if (!checkRunner) {
	logger.warn(
		"No check runner: the gate reports test, typecheck and command checks not run, and agents' run_checks refuses",
	);
}

// Agent rooms on local Docker (decided 2026-10-24): each real agent's
// Claude Code process in its own container, holding no key. Unset, it runs
// on the host. Throws on an image not pinned by digest, or when the Linux
// Claude Code binary is not installed. A restart removes what a crashed
// server left; this assumes one server process, as gate jobs do.
const agentImage = process.env.AVEL_AGENT_IMAGE || undefined;
const agentRooms = agentImage ? dockerAgentRooms({ image: agentImage }) : null;
await agentRooms?.sweep();

// The harness and Canon's model (src/runner/wiring.ts): the FakeHarness and
// the offline model unless AVEL_HARNESS=agent-sdk.
const { harness, sdk, canonModel } = harnessFromEnv(process.env, {
	stateDir: path.dirname(roomsRoot),
	ids: randomIds,
	logger,
	clock: systemClock,
	checkRunner,
	agentRooms,
});
if (sdk) {
	logger.warn(
		{ model: sdk.model, harness: sdk.version },
		"REAL HARNESS is ON: started dispatches run a real model and spend money",
	);
	if (!agentRooms) {
		logger.warn(
			"No agent rooms: each agent's process runs on this host as this user, with the API key (set AVEL_AGENT_IMAGE)",
		);
	}
} else {
	logger.warn(
		"No model is connected: dispatches run the FakeHarness and Canon answers every message with a fixed reply",
	);
}
// Read before anything starts, so a bad value refuses to start the server.
const runnerIntervalMs = intervalFromEnv(
	"AVEL_RUNNER_INTERVAL_MS",
	process.env.AVEL_RUNNER_INTERVAL_MS,
	5000,
);
const canonIntervalMs = intervalFromEnv(
	"AVEL_CANON_INTERVAL_MS",
	process.env.AVEL_CANON_INTERVAL_MS,
	3000,
);
const gateIntervalMs = intervalFromEnv(
	"AVEL_GATE_INTERVAL_MS",
	process.env.AVEL_GATE_INTERVAL_MS,
	2000,
);
const rooms = worktreeRooms(roomsRoot);
// The Drive's bytes: AVEL_BLOB_DIR, else beside the rooms. R2 replaces this
// in production behind the same interface (src/gateways/blob.ts).
const blobRoot =
	process.env.AVEL_BLOB_DIR || path.join(path.dirname(roomsRoot), "blobs");
const blobs = localDiskBlobs(blobRoot, randomIds);
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
		blobs,
		maxBytes: uploadMaxBytes,
	},
	checkRunner,
});

// The real harness files reports and findings through the app itself, in
// process, and the runner ticks here. With the FakeHarness nothing ticks.
const stops: StopLoop[] = [];
if (sdk) {
	stops.push(
		startRealRunner(
			sdk,
			app.fetch,
			{
				db: getDb,
				clock: systemClock,
				ids: randomIds,
				harness: sdk,
				prices: DEFAULT_PRICE_BOOK,
				rooms,
				roomSources,
			},
			{ intervalMs: runnerIntervalMs, logger },
		),
	);
}

// Canon's turns: a posted operator message starts one; this tick answers it.
// It always runs, model or not, because nothing else ends a turn.
stops.push(
	startCanonLoop(
		{
			db: getDb,
			clock: systemClock,
			ids: randomIds,
			prices: DEFAULT_PRICE_BOOK,
			blobs,
			model: canonModel,
			logger,
			sweepStuckTurns: sweepStuckCanonTurns,
		},
		{ intervalMs: canonIntervalMs, logger },
	),
);

// Gate runs in the background: the POST queues a job, this tick runs it.
// It always runs, because nothing else finishes a queued job.
stops.push(
	startGateJobLoop(
		{
			db: getDb,
			clock: systemClock,
			ids: randomIds,
			roomSources,
			checkRunner,
		},
		{ intervalMs: gateIntervalMs, logger },
	),
);

// Bytes an upload wrote before its commit failed (src/db/blob-sweep.ts).
stops.push(
	startBlobSweepLoop(
		{ db: getDb, clock: systemClock, blobs, logger },
		{ intervalMs: ORPHAN_SWEEP_INTERVAL_MS, logger },
	),
);

const server = serve({ fetch: app.fetch, port });
logger.info(
	{ port },
	`avel-server listening on http://localhost:${port}/api/health`,
);

// On SIGINT or SIGTERM: stop the loops and let the steps in flight commit,
// stop taking requests, close the database, exit. A second signal exits at once.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (shuttingDown) process.exit(1);
		shuttingDown = true;
		logger.info({ signal }, "shutting down");
		void shutdown({ stops, server, closeDb, logger }).then((code) =>
			process.exit(code),
		);
	});
}
