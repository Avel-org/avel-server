import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { createPlaybookBody } from "./playbook";
import { createPresetBody } from "./preset";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";

const c = initContract();

const uuid = z.string().uuid();
const iso = z.string().datetime();

/** The proposal_kind pgEnum is built from this list. */
export const PROPOSAL_KINDS = [
	"next_module",
	"calibration",
	"post_delivery",
	"intake_questions",
	"playbook",
	"preset",
] as const;

/**
 * What Canon drafts for a playbook (J, 2026-10-28: Canon drafts, the operator
 * approves). The playbook as POST /api/playbooks takes it, except that it
 * names an existing preset or carries a new one in newPreset, never both.
 */
export const playbookProposalFields = {
	playbook: createPlaybookBody.extend({ defaultPresetId: uuid.nullable() }),
	newPreset: createPresetBody.nullable(),
};

/** The refusal when a playbook draft names both presets or neither, or null. */
export function presetChoiceIssue(draft: {
	playbook: { defaultPresetId: string | null };
	newPreset: unknown;
}): string | null {
	const named = draft.playbook.defaultPresetId !== null;
	const carried = draft.newPreset !== null;
	if (named === carried) {
		return named
			? "Name an existing preset or carry a new one, not both"
			: "Name an existing preset in defaultPresetId or carry a new one in newPreset";
	}
	return null;
}

/**
 * A playbook proposal's payload. replacesVersion is null for a new mission
 * type, and otherwise the live playbook's version when Canon drafted, so an
 * approval after that playbook changed is refused (proposal_premise_changed).
 */
export const playbookProposalPayload = z
	.object({
		...playbookProposalFields,
		replacesVersion: z.number().int().positive().nullable(),
	})
	.strict()
	.superRefine((p, ctx) => {
		const issue = presetChoiceIssue(p);
		if (issue)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["newPreset"],
				message: issue,
			});
	});

/** A preset proposal's payload: a new preset, as POST /api/presets takes it. */
export const presetProposalPayload = z
	.object({ preset: createPresetBody })
	.strict();

/** Why Canon proposed it: its session, the intake it was briefing, and its reason. */
export const canonProposalPremise = z
	.object({
		canonSessionId: uuid,
		intakeId: uuid,
		reason: z.string(),
	})
	.strict();

export type PlaybookProposalPayload = z.infer<typeof playbookProposalPayload>;
export type PresetProposalPayload = z.infer<typeof presetProposalPayload>;
export type CanonProposalPremise = z.infer<typeof canonProposalPremise>;
/** The proposal_source pgEnum is built from this list. */
export const PROPOSAL_SOURCES = ["code", "model"] as const;
/** The proposal_status pgEnum is built from this list. */
export const PROPOSAL_STATUSES = [
	"pending",
	"approved",
	"dismissed",
	"expired",
] as const;

export const proposalKind = z.enum(PROPOSAL_KINDS);
export const proposalStatus = z.enum(PROPOSAL_STATUSES);

/**
 * Anything proactive, from code or from a model, reaches the operator as a
 * proposal and does nothing on its own (COMMAND-CENTER.md, module 14).
 * `payload` is exactly what approving it would do; `premise` the facts it
 * was based on. It expires when its premise stops being true.
 */
export const proposalSchema = z.object({
	id: uuid,
	kind: proposalKind,
	source: z.enum(PROPOSAL_SOURCES),
	engagementId: uuid.nullable(),
	missionId: uuid.nullable(),
	summary: z.string(),
	payload: z.unknown(),
	premise: z.unknown(),
	status: proposalStatus,
	/** The operator's note on dismissing. */
	reason: z.string().nullable(),
	decidedBy: uuid.nullable(),
	decidedAt: iso.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type Proposal = z.infer<typeof proposalSchema>;

export const proposalListQuery = pageQuery.extend({
	status: proposalStatus.optional(),
});

export const proposalListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(proposalSchema),
	meta: pageMeta.extend({
		/** The proposals the status filter keeps, ignoring the cursor. */
		total: z.number().int().nonnegative(),
		/** Over every proposal, ignoring the status filter. */
		counts: z.object({
			pending: z.number().int().nonnegative(),
			approved: z.number().int().nonnegative(),
			dismissed: z.number().int().nonnegative(),
			expired: z.number().int().nonnegative(),
		}),
	}),
});

const byId = z.object({ id: uuid });

/**
 * The operator's queue (module 14; J, 2026-10-24: the queue before any
 * source). Only a pending proposal is decided, once. Approving starts its
 * kind's action through the normal path. Only playbook and preset have one;
 * every other kind refuses proposal_action_not_built.
 */
export const proposalContract = c.router({
	list: {
		method: "GET",
		path: "/api/proposals",
		query: proposalListQuery,
		responses: { 200: proposalListEnvelope },
		summary: "Proposals, newest first, with counts by status",
	},
	approve: {
		method: "POST",
		path: "/api/proposals/:id/approve",
		pathParams: byId,
		body: c.noBody(),
		responses: { 200: successEnvelope(proposalSchema) },
		summary:
			"pending → approved, starting the kind's action: a playbook or preset is written as its own route would write it, in one transaction. Other kinds refuse (422 proposal_action_not_built); a playbook whose live version moved since the draft refuses (422 proposal_premise_changed)",
	},
	dismiss: {
		method: "POST",
		path: "/api/proposals/:id/dismiss",
		pathParams: byId,
		body: z.object({ reason: z.string().trim().min(1).max(2_000) }).strict(),
		responses: { 200: successEnvelope(proposalSchema) },
		summary: "pending → dismissed, with the operator's reason",
	},
});
