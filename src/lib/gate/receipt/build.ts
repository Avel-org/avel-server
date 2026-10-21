import type { DispatchStatus } from "../../../contract/shared/status";
import { canonicalJson } from "../../canonical";
import { sha256Hex } from "../../tokens";
import type { GateConfig } from "../config";
import type {
	Decision,
	GateFinding,
	GateFindingKind,
	IgnoredOverride,
} from "../types";

/**
 * Bumped whenever the same input could give a different receipt.
 * 2 (2026-10-21): assurance, and the decision's notChecked.
 */
export const RECEIPT_VERSION = 2;

/**
 * What `deterministicFindings` hashes: findings of these kinds, and checks
 * from these sources. Each comes from a function of the commit alone, so the
 * same commit gives the same hash. Judge and runner findings are left out.
 */
export const DETERMINISTIC_KINDS = [
	"checkpoint",
	"prior_finding",
] as const satisfies readonly GateFindingKind[];
export const DETERMINISTIC_CHECK_SOURCES = [
	"file_exists",
	"spec-check",
] as const;

export type ReceiptOverride = {
	findingId: string;
	commitSha: string;
	rationale: string;
	operatorId: string;
};

export type ReceiptJudge = {
	dispatchId: string;
	agentVersionSha256: string | null;
	skillsSha256: string | null;
	model: string | null;
	status: DispatchStatus;
};

export type ReceiptDispatch = {
	id: string;
	briefSha256: string | null;
	harnessVersion: string | null;
	priceVersion: string | null;
	spendUsd: number;
};

export type ReceiptInput = {
	missionId: string;
	commitSha: string;
	baseSha: string;
	decision: Decision;
	/** The whole gate config the decision ran under (GATE_CONFIG). */
	config: GateConfig;
	/** The findings decide() read, in any order. */
	findings: readonly GateFinding[];
	/** Every override decide() was given, applied or not. */
	overrides: readonly ReceiptOverride[];
	judges: readonly ReceiptJudge[];
	dispatches: readonly ReceiptDispatch[];
};

export type Receipt = { json: string; sha256: string };

/**
 * The verification receipt (DECISIONS-V2, Five gate additions, 1): what was
 * checked, what passed, and every override, as canonical JSON with its
 * SHA-256. Pure: no clock, no signing, no files.
 *
 * It refuses, by throwing, input that does not agree with the decision:
 * another commit, a finding the decision never read, or an override missing
 * on either side. A receipt can therefore never carry a decision with an
 * override and leave the override out.
 */
export function buildReceipt(input: ReceiptInput): Receipt {
	const { decision } = input;
	if (decision.commitSha !== input.commitSha) {
		throw new Error(
			`The decision is for ${decision.commitSha}, not ${input.commitSha}`,
		);
	}
	checkFindingsMatch(input.findings, decision);

	const findings = sortBy(input.findings, (f) => f.id);
	const deterministic = findings.filter(isDeterministic);
	// Every field, with its lists sorted: they are sets, so order is not config.
	const config = {
		version: input.config.version,
		availableSources: [...input.config.availableSources].sort(cmp),
		testGlobs: [...input.config.testGlobs].sort(cmp),
		protectedPaths: [...input.config.protectedPaths].sort(cmp),
		judgeCoverageGate: input.config.judgeCoverageGate,
	};

	for (const d of input.dispatches) {
		if (!Number.isFinite(d.spendUsd) || d.spendUsd < 0) {
			throw new Error(`Dispatch ${d.id} has spend ${d.spendUsd}`);
		}
	}

	const receipt = {
		receiptVersion: RECEIPT_VERSION,
		missionId: input.missionId,
		commitSha: input.commitSha,
		baseSha: input.baseSha,
		verdict: decision.verdict,
		assurance: decision.assurance,
		decideVersion: decision.version,
		config: { ...config, sha256: sha256Hex(canonicalJson(config)) },
		overrides: overridesSection(input.overrides, decision),
		degraded: decision.reasons
			.filter((r) => r.degraded)
			.map((r) => ({ findingId: r.findingId, gate: r.gate, source: r.source })),
		deterministicFindings: {
			kinds: [...DETERMINISTIC_KINDS],
			checkSources: [...DETERMINISTIC_CHECK_SOURCES],
			findingIds: deterministic.map((f) => f.id),
			sha256: sha256Hex(canonicalJson(deterministic)),
		},
		decision,
		findings,
		judges: sortBy(input.judges, (j) => j.dispatchId),
		dispatches: sortBy(input.dispatches, (d) => d.id),
	};
	const json = canonicalJson(receipt);
	return { json, sha256: sha256Hex(json) };
}

function isDeterministic(f: GateFinding): boolean {
	if ((DETERMINISTIC_KINDS as readonly string[]).includes(f.kind)) return true;
	return (
		f.kind === "check" &&
		(DETERMINISTIC_CHECK_SOURCES as readonly string[]).includes(f.source)
	);
}

/** Every finding the decision gave a reason for, and no other. */
function checkFindingsMatch(
	findings: readonly GateFinding[],
	decision: Decision,
): void {
	const read = new Set(
		decision.reasons
			.filter((r) => r.kind !== "synthesized")
			.map((r) => `${r.kind}\0${r.findingId}`),
	);
	const given = new Set(findings.map((f) => `${f.kind}\0${f.id}`));
	for (const key of given) {
		if (!read.has(key)) {
			throw new Error(
				`The decision did not read finding ${key.split("\0")[1]}`,
			);
		}
	}
	for (const key of read) {
		if (!given.has(key)) {
			throw new Error(
				`Finding ${key.split("\0")[1]} is missing from the input`,
			);
		}
	}
}

type OverrideEntry = ReceiptOverride & {
	applied: boolean;
	ignoredBecause: IgnoredOverride["why"] | null;
};

/**
 * Every override, each matched to what the decision did with it. Both
 * directions must match: an override the decision applied or ignored that
 * the input lacks, or one in the input the decision never saw, throws.
 */
function overridesSection(
	overrides: readonly ReceiptOverride[],
	decision: Decision,
): OverrideEntry[] {
	const applied = new Set<string>();
	for (const r of decision.reasons) {
		if (r.effect !== "overridden") continue;
		for (const rationale of r.overrides) {
			applied.add(key(r.findingId, decision.commitSha, rationale));
		}
	}
	const ignored = new Map<string, IgnoredOverride["why"]>();
	for (const o of decision.ignoredOverrides) {
		ignored.set(key(o.findingId, o.commitSha, o.rationale), o.why);
	}

	const given = new Set<string>();
	const entries = overrides.map((o): OverrideEntry => {
		const k = key(o.findingId, o.commitSha, o.rationale);
		given.add(k);
		const why = ignored.get(k);
		if (applied.has(k)) return { ...o, applied: true, ignoredBecause: null };
		if (why !== undefined) return { ...o, applied: false, ignoredBecause: why };
		throw new Error(`The decision never saw the override for ${o.findingId}`);
	});
	for (const k of [...applied, ...ignored.keys()]) {
		if (!given.has(k)) {
			throw new Error(
				`The decision used an override for ${k.split("\0")[0]} that the input does not carry`,
			);
		}
	}
	return sortBy(entries, (e) =>
		[e.findingId, e.commitSha, e.rationale, e.operatorId].join("\0"),
	);
}

function key(findingId: string, commitSha: string, rationale: string): string {
	return [findingId, commitSha, rationale].join("\0");
}

/** Code-unit order, never locale order (DEV-TIPS §2). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted by key, then by the canonical JSON, so equal keys still sort one way. */
function sortBy<T>(items: readonly T[], keyOf: (t: T) => string): T[] {
	return [...items].sort(
		(a, b) =>
			cmp(keyOf(a), keyOf(b)) || cmp(canonicalJson(a), canonicalJson(b)),
	);
}
