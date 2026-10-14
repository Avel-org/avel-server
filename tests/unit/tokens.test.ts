import { describe, expect, it } from "vitest";
import { sequentialIds } from "../../src/lib/ids";
import {
	DISPATCH_TOKEN_PREFIX,
	mintToken,
	RUNNER_CREDENTIAL_PREFIX,
	runnerCredentialSha256,
	sameSha256,
	sha256Hex,
} from "../../src/lib/tokens";

describe("tokens", () => {
	it("mints the prefix and 64 hex characters from two ids", () => {
		const token = mintToken(DISPATCH_TOKEN_PREFIX, sequentialIds());
		expect(token).toBe(
			`avl_dsp_${"00000000000040008000000000000001"}${"00000000000040008000000000000002"}`,
		);
		expect(token).toMatch(/^avl_dsp_[0-9a-f]{64}$/);
	});

	it("hashes to the hex SHA-256", () => {
		// echo -n abc | sha256sum
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("compares digests, and never matches a malformed one", () => {
		const a = sha256Hex("a");
		expect(sameSha256(a, sha256Hex("a"))).toBe(true);
		expect(sameSha256(a, sha256Hex("b"))).toBe(false);
		expect(sameSha256(a.toUpperCase(), a)).toBe(false);
		expect(sameSha256(a.slice(2), a.slice(2))).toBe(false);
		expect(sameSha256("", "")).toBe(false);
	});
});

describe("runnerCredentialSha256", () => {
	const secret = "x".repeat(32);

	it("is null when unset or empty: no runner", () => {
		expect(runnerCredentialSha256(undefined)).toBeNull();
		expect(runnerCredentialSha256("")).toBeNull();
	});

	it("hashes a prefixed credential with 32 characters after the prefix", () => {
		const credential = `${RUNNER_CREDENTIAL_PREFIX}${secret}`;
		expect(runnerCredentialSha256(credential)).toBe(sha256Hex(credential));
	});

	it("refuses a short or unprefixed credential, so the server will not start", () => {
		for (const bad of [
			`${RUNNER_CREDENTIAL_PREFIX}${secret.slice(1)}`,
			`avl_dsp_${secret}`,
			`${secret}${secret}`,
		]) {
			expect(() => runnerCredentialSha256(bad), bad).toThrow(
				/AVEL_RUNNER_CREDENTIAL/,
			);
		}
	});
});
