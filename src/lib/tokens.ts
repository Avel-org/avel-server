import { createHash, timingSafeEqual } from "node:crypto";
import type { IdGenerator } from "./ids";

/** A dispatch's access token: held by the agent's room, dead once the dispatch stops running. */
export const DISPATCH_TOKEN_PREFIX = "avl_dsp_";
/** The runner's credential: held by the runner process, never in a room. */
export const RUNNER_CREDENTIAL_PREFIX = "avl_run_";

/**
 * A new bearer token: the prefix and 64 hex characters from two ids. The
 * randomness is the IdGenerator's (src/lib/ids.ts), so production tokens
 * carry 244 random bits and tests get predictable ones.
 */
export function mintToken(prefix: string, ids: IdGenerator): string {
	const hex = (ids.next() + ids.next()).replaceAll("-", "");
	return `${prefix}${hex}`;
}

/** The hex SHA-256 of a token: what the server stores and looks up by. */
export function sha256Hex(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether two hex SHA-256 digests are equal, in constant time. A digest
 * that is not 64 hex characters never matches.
 */
export function sameSha256(a: string, b: string): boolean {
	const digest = /^[0-9a-f]{64}$/;
	if (!digest.test(a) || !digest.test(b)) return false;
	return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** The fewest characters a runner credential carries after its prefix. */
export const RUNNER_CREDENTIAL_MIN_SECRET = 32;

/**
 * The hash of AVEL_RUNNER_CREDENTIAL, or null when it is unset or empty, so
 * no request is the runner. A credential without the avl_run_ prefix, or
 * with fewer than 32 characters after it, throws: the server refuses to
 * start rather than accept a guessable runner.
 */
export function runnerCredentialSha256(
	credential: string | undefined,
): string | null {
	if (!credential) return null;
	const secret = credential.slice(RUNNER_CREDENTIAL_PREFIX.length);
	if (
		!credential.startsWith(RUNNER_CREDENTIAL_PREFIX) ||
		secret.length < RUNNER_CREDENTIAL_MIN_SECRET
	) {
		throw new Error(
			`AVEL_RUNNER_CREDENTIAL must be ${RUNNER_CREDENTIAL_PREFIX} followed by at least ${RUNNER_CREDENTIAL_MIN_SECRET} characters`,
		);
	}
	return sha256Hex(credential);
}
