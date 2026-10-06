import { ok } from "../contract";
import type { Clock } from "../lib/clock";

export function health(clock: Clock) {
	return async () => ({
		status: 200 as const,
		body: ok({
			ok: true as const,
			service: "avel-server" as const,
			time: clock.now().toISOString(),
		}),
	});
}
