import { serve } from "@hono/node-server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { authConfigFromEnv } from "./auth/config";
import { signInRecorder } from "./auth/sign-in-activity";
import { getDb } from "./db/client";
import * as authSchema from "./db/schema/auth";
import { systemClock } from "./lib/clock";
import { randomIds } from "./lib/ids";
import { createLogger } from "./lib/logger";

const port = Number(process.env.PORT ?? 8787);
const logger = createLogger({ level: process.env.LOG_LEVEL });
const config = authConfigFromEnv(process.env);
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
	}).fetch,
	port,
});
logger.info(
	{ port },
	`avel-server listening on http://localhost:${port}/api/health`,
);
