import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { activityActor } from "./activity";
import { findingSeverity } from "./agent";
import { gate, gatePolicy } from "./playbook";
import { successEnvelope } from "./shared/envelope";
import { idempotencyHeaders } from "./shared/idempotency";
import { pageMeta, pageQuery } from "./shared/pagination";

const c = initContract();

/**
 * The gate's vocabulary (module 9, decided 2026-10-19). Defined once here;
 * src/lib/gate imports these lists, so the wire and decide() cannot drift.
 */
export const GATE_FINDING_KINDS = [
	"check",
	"checkpoint",
	"prior_finding",
	"judge",
	"judge_coverage",
] as const;

/** Each rule, in the order decide() tries it. Reasons sort by this order within a gate. */
export const DECIDE_RULES = [
	"stale_commit",
	"checkpoint_violation",
	"checkpoint_unproven",
	"prior_finding_failed",
	"judge_open",
	"judge_confirmed",
	"unlisted_gate",
	"mandatory_failed",
	"mandatory_not_run",
	"degraded_not_run",
	"warn_failed",
	"warn_not_run",
	"passed",
] as const;

export const REASON_EFFECTS = [
	"block",
	"overridden",
	"warn",
	"pass",
	"ignored",
] as const;

/**
 * The gate's one answer, for a run and for each gate in it (J, 2026-10-21).
 * Read from the counted reasons alone (every effect but ignored):
 * - `fail`: a reason still blocks.
 * - `verified`: at least one reason, and every one passed. Nothing warned,
 *   nothing was overridden, and every check ran.
 * - `pass`: anything else. Nothing blocks, but something warned, was
 *   overridden, or did not check.
 * Only `verified` work is delivered, so an override can lift `fail` to
 * `pass` and never further.
 */
export const GATE_RESULTS = ["verified", "pass", "fail"] as const;

export const IGNORED_OVERRIDE_WHYS = [
	"wrong_commit",
	"no_rationale",
	"no_such_blocker",
	"not_overridable",
] as const;

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const iso = z.string().datetime();
const uuid = z.string().uuid();
const text = z.string().trim().min(1);

/**
 * One reason behind a gate's result. findingId is a Finding's uuid for a
 * judge, `not_run:<gate>` for a gate with no evidence, and otherwise an id
 * derived from content, stable at one commit: `spec-check:R1`,
 * `check:CK1:<n>`, `checkpoint:protected:<path>`,
 * `checkpoint:test-glob:<dispatchId>:<path>`, `judge-coverage:<rosterEntryId>`.
 */
export const gateReason = z.object({
	gate,
	findingId: z.string().min(1),
	kind: z.enum([...GATE_FINDING_KINDS, "synthesized"]),
	source: z.string().nullable(),
	subject: z.string(),
	policy: gatePolicy.nullable(),
	rule: z.enum(DECIDE_RULES),
	effect: z.enum(REASON_EFFECTS),
	/** A not_run from a check that is not installed yet: "not checked", never a pass. */
	degraded: z.boolean(),
	/** True exactly when a written override at this commit would clear it. */
	overridable: z.boolean(),
	severity: z
		.object({ model: findingSeverity, operator: findingSeverity.nullable() })
		.nullable(),
	/** The rationales of the overrides applied, sorted. */
	overrides: z.array(z.string()),
	message: z.string(),
});

export type GateReasonWire = z.infer<typeof gateReason>;

export const gateOverride = z.object({
	findingId: z.string().min(1),
	commitSha: sha40,
	rationale: text,
});

export const gateRun = z.object({
	/** The run's id: the id of its mission.gate_run activity row. */
	id: uuid,
	at: iso,
	missionId: uuid,
	/** The integration commit judged. */
	commitSha: sha40,
	/** The mission's pinned commit. */
	baseSha: sha40,
	result: z.enum(GATE_RESULTS),
	decideVersion: z.number().int().positive(),
	receiptVersion: z.number().int().positive(),
	configSha256: sha256,
	receiptSha256: sha256,
	/** Listed gates, and an unlisted gate holding the brief's checks (as mandatory), in GATES order. */
	gates: z.array(
		z.object({
			gate,
			policy: gatePolicy,
			result: z.enum(GATE_RESULTS),
			reasons: z.array(gateReason),
		}),
	),
	/** Every reason, unlisted and stale ones included, sorted. */
	reasons: z.array(gateReason),
	ignoredOverrides: z.array(
		gateOverride.extend({ why: z.enum(IGNORED_OVERRIDE_WHYS) }),
	),
	/** Dispatches that closed without completing, so were not integrated. */
	excludedDispatches: z.array(
		z.object({
			dispatchId: uuid,
			status: z.enum(["blocked", "halted", "failed"]),
			closedAt: iso,
		}),
	),
	/** The receipt, canonical JSON. Its SHA-256 is receiptSha256. */
	receipt: z.string(),
});

export type GateRun = z.infer<typeof gateRun>;

export const gateRunSummary = gateRun
	.pick({
		id: true,
		at: true,
		result: true,
		commitSha: true,
		baseSha: true,
		receiptSha256: true,
		configSha256: true,
		decideVersion: true,
		receiptVersion: true,
	})
	.extend({ actor: activityActor });

export type GateRunSummary = z.infer<typeof gateRunSummary>;

export const gateRunListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(gateRunSummary),
	meta: pageMeta,
});

export const runGateBody = z
	.object({ overrides: z.array(gateOverride).default([]) })
	.strict();

const byId = z.object({ id: uuid });

export const gateContract = c.router({
	run: {
		method: "POST",
		path: "/api/missions/:id/gate",
		pathParams: byId,
		headers: idempotencyHeaders.partial(),
		body: runGateBody,
		/** 201 for a new run; 200 with Idempotency-Replayed: true for a replay. */
		responses: {
			201: successEnvelope(gateRun),
			200: successEnvelope(gateRun),
		},
		summary:
			"Judge the mission's integration commit: findings in, result and receipt out",
	},
	runs: {
		method: "GET",
		path: "/api/missions/:id/gate-runs",
		pathParams: byId,
		query: pageQuery,
		responses: { 200: gateRunListEnvelope },
		summary: "The mission's gate runs, newest first",
	},
	getRun: {
		method: "GET",
		path: "/api/missions/:id/gate-runs/:runId",
		pathParams: z.object({ id: uuid, runId: uuid }),
		responses: { 200: successEnvelope(gateRun) },
		summary: "One gate run, rebuilt from its stored receipt",
	},
});
