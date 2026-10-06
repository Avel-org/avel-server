import { type DestinationStream, type Logger, pino } from "pino";

export type { Logger };

/**
 * The server's logger. It is created once in src/index.ts and passed in
 * through AppDeps, never imported as a global, so a test can capture or
 * silence what the app logs.
 *
 * Pino stamps each line with its own clock. Log lines are never compared
 * exactly, so this is outside the determinism rule.
 */
export function createLogger(
	options: { level?: string; destination?: DestinationStream } = {},
): Logger {
	return pino(
		{
			level: options.level ?? "info",
			base: { service: "avel-server" },
			// Never log credentials, even if a caller passes a whole request.
			redact: {
				paths: [
					"req.headers.authorization",
					"req.headers.cookie",
					'res.headers["set-cookie"]',
				],
				censor: "[redacted]",
			},
		},
		options.destination,
	);
}

/** A logger that writes nothing. */
export function silentLogger(): Logger {
	return pino({ level: "silent" });
}
