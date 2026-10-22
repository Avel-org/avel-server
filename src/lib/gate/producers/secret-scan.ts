import type { GateFinding } from "../types";
import { byId } from "./shared";

export const SECRET_SCAN_SOURCE = "secret-scan";
export const SECURITY_GATE = "security";

/** Above this a text file is not scanned, and is reported as not checked. */
export const SECRET_SCAN_MAX_BYTES = 1024 * 1024;

/**
 * Credentials that have a fixed, documented shape, so a match is a secret
 * and not a guess. No entropy rule: a high-entropy string is often a hash or
 * a fixture, and a guess that fails a run trains people to override it.
 * Changing a rule changes what the gate checks: bump GATE_CONFIG.version.
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

/** `.env` and `.env.<anything>` hold real values; these suffixes hold placeholders. */
const ENV_TEMPLATES = new Set(["example", "sample", "template", "dist"]);

export function isEnvFile(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (name === ".env") return true;
	if (!name.startsWith(".env.")) return false;
	return !ENV_TEMPLATES.has(name.slice(".env.".length));
}

export type SecretScanFile = { path: string; content: Uint8Array };

/**
 * Secrets in the files the work added or changed, on the security gate. Each
 * rule match is a fail at its path and line; so is any `.env` file, whatever
 * it holds. A subject never carries the matched text, because the receipt
 * is kept and shared. Binary files (a NUL in the first 8000 bytes, git's own
 * test) are not scanned and are named in the pass. A text file over
 * SECRET_SCAN_MAX_BYTES is an error: nothing was shown about it. No match
 * is one pass.
 */
export function secretScanFindings(
	files: readonly SecretScanFile[],
	commitSha: string,
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
		if (isEnvFile(f.path)) {
			findings.push({
				...base,
				id: `${prefix}:${f.path}:env-file`,
				subject: `${f.path}: an environment file is committed`,
				outcome: "fail",
			});
		}
		if (f.content.subarray(0, 8000).includes(0)) {
			binary.push(f.path);
			continue;
		}
		if (f.content.byteLength > SECRET_SCAN_MAX_BYTES) {
			findings.push({
				...base,
				id: `${prefix}:${f.path}:too-large`,
				subject: `${f.path}: ${f.content.byteLength} bytes, over the ${SECRET_SCAN_MAX_BYTES}-byte scan limit, not scanned`,
				outcome: "error",
			});
			continue;
		}
		const lines = new TextDecoder().decode(f.content).split("\n");
		for (const rule of SECRET_RULES) {
			lines.forEach((line, i) => {
				if (!rule.pattern.test(line)) return;
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

/** Code-unit order, never locale order (DEV-TIPS §2). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
