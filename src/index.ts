import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { authConfigFromEnv } from "./auth/config";
import { previewAuthConfig, previewConfigFromEnv } from "./auth/preview";
import { signInRecorder } from "./auth/sign-in-activity";
import { getDb } from "./db/client";
import * as authSchema from "./db/schema/auth";
import { systemClock } from "./lib/clock";
import { randomIds } from "./lib/ids";
import { createLogger } from "./lib/logger";

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
	}).fetch,
	port,
});
logger.info(
	{ port },
	`avel-server listening on http://localhost:${port}/api/health`,
);
