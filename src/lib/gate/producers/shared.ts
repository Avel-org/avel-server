import type { GateFinding } from "../types";

/** Code-unit order, never locale order (DEV-TIPS §2). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Findings in id order, so a producer's output never depends on its input's order. */
export function byId(findings: GateFinding[]): GateFinding[] {
	return findings.sort((a, b) => cmp(a.id, b.id));
}
