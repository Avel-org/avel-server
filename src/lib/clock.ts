/**
 * The only place in this codebase that reads the time.
 *
 * Everything else takes a Clock, so tests can fix "now" and compare output
 * exactly. scripts/check-determinism.sh fails the build if Date.now() or a
 * no-argument new Date() appears anywhere outside this file.
 */
export interface Clock {
	now(): Date;
}

export const systemClock: Clock = {
	now: () => new Date(),
};

export function fixedClock(iso: string): Clock {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) {
		throw new Error(`fixedClock: not a valid ISO timestamp: ${iso}`);
	}
	return { now: () => new Date(at.getTime()) };
}
