import type { z } from "zod";
import type { exportTargetKind } from "../../../contract/mission";
import type { ErrorCode } from "../../../contract/shared/errors";
import type { Violation } from "./types";

/**
 * The delivery guards (EXPORT-ENGINE.md §4). Each is a pure function of plain
 * values: no database, network or clock. They run before any target is
 * constructed, and the targets do no checking of their own.
 *
 * Two rules hold by shape. checkNoViolations takes no override, and
 * checkPreviewFresh takes two shas and nothing else. Tests pin their arity.
 */

/** The gate's result. Only `verified` is delivered, to every target (J, 2026-10-21). */
export const GATE_RESULTS = ["verified", "pass", "fail"] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

export type DeliveryTarget = z.infer<typeof exportTargetKind>;

export const REFUSAL_REASONS = [
	"gate_pass_not_verified",
	"gate_failed",
	"blast_radius_violation",
	"preview_required",
	"preview_mission_mismatch",
	"preview_stale",
	"package_hash_version_mismatch",
	"package_hash_mismatch",
	"direct_push_not_allowed",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export const WARNINGS = ["preview_absent"] as const;
export type DeliveryWarning = (typeof WARNINGS)[number];

export type Refusal = {
	ok: false;
	/** The envelope code a route answers with. */
	code: ErrorCode;
	reason: RefusalReason;
	message: string;
	details?: Readonly<Record<string, unknown>>;
};

export type Allowed = { ok: true; warnings: DeliveryWarning[] };

export type GuardResult = Allowed | Refusal;

const allowed = (...warnings: DeliveryWarning[]): Allowed => ({
	ok: true,
	warnings,
});

/**
 * Only a verified gate result is delivered. A pass is not enough: some check
 * that would have judged the work did not run. No override reaches here, so
 * none can make work deliverable.
 */
export function checkGateVerified(result: GateResult): GuardResult {
	if (result === "verified") return allowed();
	if (result === "pass") {
		return {
			ok: false,
			code: "PRECONDITION_FAILED",
			reason: "gate_pass_not_verified",
			message:
				"The gate passed but did not verify the work. Only verified work is delivered.",
		};
	}
	return {
		ok: false,
		code: "PRECONDITION_FAILED",
		reason: "gate_failed",
		message: "The gate failed. Failed work is not delivered.",
	};
}

/** Any violation refuses. There is no override parameter, so none can be passed. */
export function checkNoViolations(
	violations: readonly Violation[],
): GuardResult {
	if (violations.length === 0) return allowed();
	return {
		ok: false,
		code: "BLAST_RADIUS_VIOLATION",
		reason: "blast_radius_violation",
		message: `The delivery would break ${violations.length} path rule${violations.length === 1 ? "" : "s"}. A violation is never overridable.`,
		details: { violations: violations.map((v) => ({ ...v })) },
	};
}

/**
 * github_push refuses without a linked preview. github_pr is allowed and
 * warned. zip does not need one (EXPORT-ENGINE.md §7).
 */
export function checkPreviewRequired(
	target: DeliveryTarget,
	previewExportId: string | null,
): GuardResult {
	if (previewExportId !== null) return allowed();
	if (target === "github_push") {
		return {
			ok: false,
			code: "PREVIEW_REQUIRED",
			reason: "preview_required",
			message: "A push needs a preview of the same mission first.",
		};
	}
	if (target === "github_pr") return allowed("preview_absent");
	return allowed();
}

/** A preview approves one mission's delivery, never another's. */
export function checkPreviewMatchesMission(
	previewMissionId: string,
	missionId: string,
): GuardResult {
	if (previewMissionId === missionId) return allowed();
	return {
		ok: false,
		code: "PRECONDITION_FAILED",
		reason: "preview_mission_mismatch",
		message: "The preview is of a different mission.",
		details: { previewMissionId, missionId },
	};
}

/**
 * The branch tip must not have moved since the preview. Two shas and nothing
 * else: whether the changes overlap is never asked (EXPORT-ENGINE.md §5).
 * Null is an empty repository, and an empty repository that gained a commit
 * has moved.
 */
export function checkPreviewFresh(
	previewBaseSha: string | null,
	currentBaseSha: string | null,
): GuardResult {
	if (previewBaseSha === currentBaseSha) return allowed();
	return {
		ok: false,
		code: "PREVIEW_STALE",
		reason: "preview_stale",
		message: "The branch moved since the preview. Preview again.",
		details: { previewBaseSha, currentBaseSha },
	};
}

/**
 * The real render's package hash must equal its preview's, under the same
 * hash definition (EXPORT-ENGINE.md §6). Different definitions cannot be
 * compared, which is its own refusal and not a determinism violation.
 */
export function checkDeterminism(
	previewPackageSha: string,
	previewHashVersion: number,
	packageSha: string,
	hashVersion: number,
): GuardResult {
	if (previewHashVersion !== hashVersion) {
		return {
			ok: false,
			code: "PRECONDITION_FAILED",
			reason: "package_hash_version_mismatch",
			message:
				"The preview's package hash was made under a different definition. Preview again.",
			details: { previewHashVersion, hashVersion },
		};
	}
	if (previewPackageSha !== packageSha) {
		return {
			ok: false,
			code: "DETERMINISM_VIOLATION",
			reason: "package_hash_mismatch",
			message:
				"The render produced different bytes from its preview. Something nondeterministic reached the render.",
			details: { previewPackageSha, packageSha, hashVersion },
		};
	}
	return allowed();
}

/**
 * A push to the repository's default branch needs its RepoPolicy to allow
 * it; a repo with no policy never does (DATA-CONTRACTS-V2.md, RepoPolicy).
 * Any other branch, and any other target, is allowed here.
 */
export function checkDirectPush(push: PushTarget | null): GuardResult {
	if (push === null || push.branch !== push.defaultBranch) return allowed();
	if (push.allowDirectPushToDefault) return allowed();
	return {
		ok: false,
		code: "PRECONDITION_FAILED",
		reason: "direct_push_not_allowed",
		message: `${push.branch} is the repository's default branch, and its policy does not allow a direct push. Open a pull request, or push to another branch.`,
	};
}

/** Where a github_push writes, and whether its repo's policy allows the default branch. */
export type PushTarget = {
	branch: string;
	defaultBranch: string;
	allowDirectPushToDefault: boolean;
};

export type LinkedPreview = {
	exportId: string;
	missionId: string;
	baseCommitSha: string | null;
	packageSha: string;
	packageHashVersion: number;
};

export type DeliverableInput = {
	gateResult: GateResult;
	violations: readonly Violation[];
	target: DeliveryTarget;
	missionId: string;
	preview: LinkedPreview | null;
	/** The branch tip re-read at delivery. Null for an empty repository, and for zip. */
	currentBaseSha: string | null;
	packageSha: string;
	packageHashVersion: number;
	/** A github_push's branch and policy; null for every other target. */
	push: PushTarget | null;
};

/**
 * Every guard, in a fixed order, and the first refusal wins: gate, then
 * violations, then the preview's presence, a push's policy, then the
 * preview's mission, freshness and hash.
 * Without a linked preview the last three have nothing to compare. Warnings
 * from guards that allowed are kept.
 */
export function checkDeliverable(input: DeliverableInput): GuardResult {
	const warnings: DeliveryWarning[] = [];
	const steps: Array<() => GuardResult> = [
		() => checkGateVerified(input.gateResult),
		() => checkNoViolations(input.violations),
		() => checkPreviewRequired(input.target, input.preview?.exportId ?? null),
		() => checkDirectPush(input.push),
	];
	const preview = input.preview;
	if (preview !== null) {
		steps.push(
			() => checkPreviewMatchesMission(preview.missionId, input.missionId),
			() => checkPreviewFresh(preview.baseCommitSha, input.currentBaseSha),
			() =>
				checkDeterminism(
					preview.packageSha,
					preview.packageHashVersion,
					input.packageSha,
					input.packageHashVersion,
				),
		);
	}
	for (const step of steps) {
		const result = step();
		if (!result.ok) return result;
		warnings.push(...result.warnings);
	}
	return { ok: true, warnings };
}
