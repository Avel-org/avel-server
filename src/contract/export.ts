import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { GATE_RESULTS } from "./gate";
import { exportTargetKind } from "./mission";
import { successEnvelope } from "./shared/envelope";
import { idempotencyHeaders } from "./shared/idempotency";
import { pageMeta, pageQuery } from "./shared/pagination";
import { exportStatus } from "./shared/status";

const c = initContract();

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const iso = z.string().datetime();
const uuid = z.string().uuid();

/**
 * Why a path breaks the delivery's path rules (BLAST-RADIUS.md, Violations).
 * Defined once here; src/lib/export/delivery imports it. Any one blocks
 * delivery, and none is overridable.
 */
export const VIOLATION_CODES = [
	"PATH_OUTSIDE_ALLOWED",
	"PATH_TRAVERSAL",
	"PATH_NOT_NORMALIZED",
	"SPECIAL_FILE_COLLISION",
	"PATH_TYPE_COLLISION",
	"CASE_COLLISION",
	"PROTECTED_PATH",
	"DUPLICATE_PATH",
	"UNSUPPORTED_MODE",
	"DELETE_NOT_FOUND",
	"POLICY_GLOB_UNSUPPORTED",
] as const;

export const violationCode = z.enum(VIOLATION_CODES);

export const violation = z.object({
	code: violationCode,
	path: z.string(),
	detail: z.string(),
});

/** A file the delivery writes: its git mode, its length, and git's blob sha of its bytes. */
const fileEntry = z.object({
	path: z.string(),
	mode: z.string(),
	bytes: z.number().int().nonnegative(),
	blobSha: sha40,
});

/**
 * What a GitHub delivery would do to the target branch (BLAST-RADIUS.md),
 * computed against its tip. Every list is in codepoint order. The files the
 * branch keeps are never listed, only counted.
 */
export const blastRadius = z.object({
	computedAt: iso,
	baseRef: z.string(),
	/** The tip it was computed against. Null for an empty repository. */
	baseCommitSha: sha40.nullable(),
	target: z.object({ owner: z.string(), repo: z.string(), branch: z.string() }),
	create: z.array(fileEntry),
	overwrite: z.array(
		fileEntry.extend({ remoteBlobSha: sha40, remoteMode: z.string() }),
	),
	unchanged: z.array(fileEntry),
	delete: z.array(
		z.object({
			path: z.string(),
			remoteBlobSha: sha40,
			remoteMode: z.string(),
		}),
	),
	preserveSummary: z.object({
		fileCount: z.number().int().nonnegative(),
		topLevelDirs: z.array(z.string()),
	}),
	violations: z.array(violation),
	totals: z.object({
		create: z.number().int().nonnegative(),
		overwrite: z.number().int().nonnegative(),
		unchanged: z.number().int().nonnegative(),
		delete: z.number().int().nonnegative(),
		violations: z.number().int().nonnegative(),
	}),
});

export type BlastRadiusWire = z.infer<typeof blastRadius>;

/**
 * Why delivery would be refused, in the order the guards run: the first
 * refusal checkDeliverable gives. A preview records it instead of refusing,
 * so the pre-flight screen can show it; a create answers it as the error.
 */
export const deliveryBlock = z.object({
	code: z.enum([
		"PRECONDITION_FAILED",
		"BLAST_RADIUS_VIOLATION",
		"PREVIEW_REQUIRED",
		"PREVIEW_STALE",
		"DETERMINISM_VIOLATION",
	]),
	reason: z.enum([
		"gate_pass_not_verified",
		"gate_failed",
		"blast_radius_violation",
		"preview_required",
		"preview_mission_mismatch",
		"preview_stale",
		"package_hash_version_mismatch",
		"package_hash_mismatch",
		"direct_push_not_allowed",
	]),
	message: z.string(),
});

/**
 * One export (DATA-CONTRACTS-V2.md, Export). A preview is an export with
 * dryRun true, terminal at `previewed`, never promoted. Until GitHub delivery
 * is built, an export's status is final when its route answers: a preview
 * is `previewed` and a zip is `done`. A refusal writes no export.
 */
export const exportSchema = z.object({
	id: uuid,
	missionId: uuid,
	sprintN: z.number().int(),
	targetKind: exportTargetKind,
	/** What authorizes a GitHub target. Null only for zip. */
	connectionId: uuid.nullable(),
	status: exportStatus,
	/** When the export entered its current status. Never before createdAt. */
	statusChangedAt: iso,
	dryRun: z.boolean(),
	/** The preview a real export was approved from. Null for a preview, and for a zip made without one. */
	previewExportId: uuid.nullable(),
	/**
	 * The gate run whose integration commit this export ships. Null, with
	 * package, only before it rendered: pending, rendering, or failed first.
	 */
	gateRun: z
		.object({
			id: uuid,
			result: z.enum(GATE_RESULTS),
			/** The integration commit the gate judged and the package is rendered from. */
			commitSha: sha40,
			/** The mission's base: the commit the work started from. */
			baseSha: sha40,
			receiptSha256: sha256,
		})
		.nullable(),
	/** A GitHub target's branch. Null for zip. */
	baseRef: z.string().nullable(),
	/** That branch's tip when the blast radius was computed. Null for zip and for an empty repository. */
	baseCommitSha: sha40.nullable(),
	/**
	 * The package: the files the integration commit changed from the
	 * mission's base, plus .avel/receipt.json and each complete dispatch's
	 * frozen brief at .avel/dispatches/<dispatch id>.md, and the paths it deleted.
	 * `change` is against the mission's base. sha256 is packageSha256, which
	 * leaves the receipt out, under hashVersion. Null exactly when gateRun is.
	 */
	package: z
		.object({
			sha256: sha256,
			hashVersion: z.number().int().positive(),
			files: z.array(
				fileEntry.extend({ change: z.enum(["create", "overwrite"]) }),
			),
			deletes: z.array(z.string()),
		})
		.nullable(),
	/**
	 * The path rules the package breaks. For a zip, against the mission's
	 * base; for a GitHub target, the blast radius's own list. Empty before
	 * it rendered.
	 */
	violations: z.array(violation),
	/** GitHub targets only. Null for zip. */
	blastRadius: blastRadius.nullable(),
	/** Why delivering this would be refused now, or null when nothing would. A done export carries null. */
	blocked: deliveryBlock.nullable(),
	/**
	 * A github_pr export's pull request, once GitHub opened it; null before,
	 * for every other target, and for a PR opened before 2026-10-24. state
	 * is read from GitHub by POST /api/exports/:id/refresh.
	 */
	pullRequest: z
		.object({
			number: z.number().int().positive(),
			url: z.string().url(),
			/** The branch AVEL made: avel/<mission id first 8>-s<sprint>-<package sha first 12>. */
			branch: z.string(),
			/** The commit AVEL made on it. */
			commitSha: sha40,
			state: z.enum(["open", "merged", "closed"]),
		})
		.nullable(),
	/** A done github_push export's branch and the commit AVEL made, now its tip; null otherwise. */
	push: z.object({ branch: z.string(), commitSha: sha40 }).nullable(),
	/** Why a real export failed, written for the operator; null unless status is failed. */
	failure: z.object({ code: z.string(), message: z.string() }).nullable(),
	/** The zip's sha256 and length. Set on a done zip; its bytes are at GET /api/exports/:id/zip. */
	zip: z
		.object({ sha256: sha256, bytes: z.number().int().positive() })
		.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type ExportWire = z.infer<typeof exportSchema>;

const connectionAndRef = {
	/** Required for a GitHub target, refused for zip. */
	connectionId: uuid.optional(),
	/** A GitHub target's branch. Omitted: the repository's default branch. Refused for zip. */
	ref: z.string().trim().min(1).max(255).optional(),
};

function zipTakesNoConnection(
	body: { target: string; connectionId?: string; ref?: string },
	ctx: z.RefinementCtx,
) {
	if (body.target === "zip") {
		if (body.connectionId !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["connectionId"],
				message: "A zip takes no connection",
			});
		}
		if (body.ref !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["ref"],
				message: "A zip takes no ref",
			});
		}
	} else if (body.connectionId === undefined) {
		ctx.addIssue({
			code: "custom",
			path: ["connectionId"],
			message: "A GitHub target needs a connection",
		});
	}
}

export const previewExportBody = z
	.object({ missionId: uuid, target: exportTargetKind, ...connectionAndRef })
	.strict()
	.superRefine(zipTakesNoConnection);

export const createExportBody = z
	.object({
		missionId: uuid,
		target: exportTargetKind,
		/** The gate run the operator saw. Refused (gate_run_not_latest) when a newer run exists. */
		gateRunId: uuid,
		/** Required for github_push; github_pr without one is warned; a zip needs none. */
		previewExportId: uuid.optional(),
		...connectionAndRef,
	})
	.strict()
	.superRefine(zipTakesNoConnection);

export const exportListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(exportSchema),
	meta: pageMeta,
});

/**
 * Module 10 and 11: previews for every target (J, 2026-10-22), and delivery
 * by zip, GitHub pull request (2026-10-24) and push (2026-10-24). The zip's
 * bytes are behind a byte route outside this contract: GET /api/exports/:id/zip.
 */
export const exportContract = c.router({
	preview: {
		method: "POST",
		path: "/api/exports/preview",
		headers: idempotencyHeaders,
		body: previewExportBody,
		/** 201 for a new preview; 200 with Idempotency-Replayed: true for a replay. */
		responses: {
			201: successEnvelope(exportSchema),
			200: successEnvelope(exportSchema),
		},
		summary:
			"Render the mission's latest gate run and record what delivering it would do, as a dry run",
	},
	create: {
		method: "POST",
		path: "/api/exports",
		headers: idempotencyHeaders,
		body: createExportBody,
		/** 201 for a new export; 200 with Idempotency-Replayed: true for a replay. */
		responses: {
			201: successEnvelope(exportSchema),
			200: successEnvelope(exportSchema),
		},
		summary:
			"Render the gate run again and deliver it: a zip, a GitHub pull request, or a push to a branch",
	},
	refresh: {
		method: "POST",
		path: "/api/exports/:id/refresh",
		pathParams: z.object({ id: uuid }),
		body: c.noBody(),
		responses: { 200: successEnvelope(exportSchema) },
		summary:
			"Read a github_pr export's pull request on GitHub: pr-open moves to done when it merged and closed when it closed; a delivering export whose PR exists moves to pr-open",
	},
	get: {
		method: "GET",
		path: "/api/exports/:id",
		pathParams: z.object({ id: uuid }),
		responses: { 200: successEnvelope(exportSchema) },
		summary: "One export",
	},
	list: {
		method: "GET",
		path: "/api/missions/:id/exports",
		pathParams: z.object({ id: uuid }),
		query: pageQuery,
		responses: { 200: exportListEnvelope },
		summary: "The mission's exports, previews included, newest first",
	},
});
