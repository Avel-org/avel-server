import { BINARY_SNIFF_BYTES } from "../../../rooms/git";
import type { GateFinding } from "../types";
import { byId, cmp } from "./shared";

export const SECRET_SCAN_SOURCE = "secret-scan";
export const SECURITY_GATE = "security";

/** Above this a text file is not scanned, and is reported as not checked. */
export const SECRET_SCAN_MAX_BYTES = 1024 * 1024;

/**
 * Credentials that have a fixed, documented shape, so a match is a secret
 * and not a guess. No entropy rule: a high-entropy string is often a hash or
 * a fixture, and a guess that fails a run trains people to override it.
 * GATE_CONFIG carries these, so the receipt's config hash changes with them.
 */
export const SECRET_RULES: readonly { id: string; pattern: RegExp }[] = [
	{
		id: "private-key",
		pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/,
	},
	{ id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ id: "github-token", pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
	{
		id: "github-fine-grained-token",
		pattern: /\bgithub_pat_[0-9A-Za-z_]{82}\b/,
	},
	{ id: "slack-token", pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}/ },
	{ id: "stripe-live-key", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/ },
	{ id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ id: "anthropic-api-key", pattern: /\bsk-ant-[0-9A-Za-z_-]{32,}/ },
	{
		id: "openai-api-key",
		pattern: /\bsk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{32,}/,
	},
];

/**
 * `.env` and `.env.<anything>` hold real values. A name whose last segment
 * is one of these holds placeholders: `.env.example`, `.env.local.example`.
 */
export const ENV_TEMPLATE_SUFFIXES: readonly string[] = [
	"defaults",
	"dist",
	"example",
	"sample",
	"schema",
	"template",
];

/** What the secret scan checks, carried in GATE_CONFIG so the receipt's config hash covers it. */
export type SecretScanConfig = {
	rules: readonly { id: string; pattern: RegExp }[];
	envTemplateSuffixes: readonly string[];
	maxBytes: number;
};

export const SECRET_SCAN_CONFIG: SecretScanConfig = Object.freeze({
	rules: SECRET_RULES,
	envTemplateSuffixes: ENV_TEMPLATE_SUFFIXES,
	maxBytes: SECRET_SCAN_MAX_BYTES,
});

export function isEnvFile(
	path: string,
	templates: readonly string[] = ENV_TEMPLATE_SUFFIXES,
): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (name === ".env") return true;
	if (!name.startsWith(".env.")) return false;
	const last = name.slice(name.lastIndexOf(".") + 1);
	return !templates.includes(last);
}

export type SecretScanFile = {
	path: string;
	/** The blob's size at head. */
	size: number;
	/** Whole when `size` is at most SECRET_SCAN_MAX_BYTES, else its first bytes. */
	bytes: Uint8Array;
	/**
	 * The base's blob at the same path, or null when the base has no file
	 * there. Its lines are the client's, so a match on one of them is not
	 * this work's. An empty array when the base's blob was not read: then
	 * every matching line counts.
	 */
	base: Uint8Array | null;
};

/**
 * Secrets the work added, on the security gate, read from the files it
 * added or changed. A rule match is a fail at its path and line, unless the
 * base had that exact line at that path: the client's own secret is not this
 * mission's finding (DECISIONS-V2, 2026-10-22). A `.env` file the base did
 * not have is a fail whatever it holds. A subject never carries the matched
 * text, because the receipt is kept and shared. Binary files (a NUL in the
 * first 8000 bytes, git's own test) are not scanned and are named in the
 * pass. A text file over SECRET_SCAN_MAX_BYTES is an error: nothing was
 * shown about it. No match is one pass.
 *
 * A renamed file is a delete and an add here, so a secret it carried from
 * the base counts as added.
 */
export function secretScanFindings(
	files: readonly SecretScanFile[],
	commitSha: string,
	config: SecretScanConfig = SECRET_SCAN_CONFIG,
): GateFinding[] {
	const base = {
		gate: SECURITY_GATE,
		kind: "check",
		source: SECRET_SCAN_SOURCE,
		commitSha,
	} as const;
	const prefix = "check:secret";
	const sorted = [...files].sort((a, b) => cmp(a.path, b.path));
	const findings: GateFinding[] = [];
	const binary: string[] = [];
	for (const f of sorted) {
		if (isEnvFile(f.path, config.envTemplateSuffixes) && f.base === null) {
			findings.push({
				...base,
				id: `${prefix}:${f.path}:env-file`,
				subject: `${f.path}: an environment file is committed`,
				outcome: "fail",
			});
		}
		if (f.bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
			binary.push(f.path);
			continue;
		}
		// Bytes short of the size were not read whole, whatever the limit says.
		if (f.size > config.maxBytes || f.bytes.byteLength < f.size) {
			findings.push({
				...base,
				id: `${prefix}:${f.path}:too-large`,
				subject: `${f.path}: ${f.size} bytes, over the ${config.maxBytes}-byte scan limit, not scanned`,
				outcome: "error",
			});
			continue;
		}
		const theirs = new Set(f.base ? lines(f.base) : []);
		const ours = lines(f.bytes);
		for (const rule of config.rules) {
			ours.forEach((line, i) => {
				if (theirs.has(line) || !rule.pattern.test(line)) return;
				findings.push({
					...base,
					id: `${prefix}:${f.path}:${i + 1}:${rule.id}`,
					subject: `${f.path}:${i + 1}: matches ${rule.id}`,
					outcome: "fail",
				});
			});
		}
	}
	if (findings.length > 0) return byId(findings);
	const scanned = sorted.length - binary.length;
	const skipped =
		binary.length > 0 ? `; binary, not scanned: ${binary.join(", ")}` : "";
	return [
		{
			...base,
			id: prefix,
			subject: `No secret in the ${scanned} text files the work added or changed${skipped}`,
			outcome: "pass",
		},
	];
}

function lines(bytes: Uint8Array): string[] {
	return new TextDecoder().decode(bytes).split("\n");
}
