import { z } from "zod";
import { SIDES } from "../role-labels";

/**
 * The one error code union. Every error envelope carries one of these, and
 * the frontend switches on it. It never parses the message.
 *
 * Adding a code is a contract change: avel-web's error map is keyed on this
 * union, so a new code fails its build until the code has copy.
 */
export const errorCode = z.enum([
	// Generic: any resource route, and sign-in.
	"VALIDATION_FAILED",
	"UNAUTHENTICATED",
	"FORBIDDEN",
	// A live session whose GitHub id has left the operator allowlist. Distinct
	// from FORBIDDEN so a client can show sign-out without guessing.
	"NOT_OPERATOR",
	"NOT_FOUND",
	"CONFLICT",
	"INTERNAL",

	// Named on route responses in DATA-CONTRACTS-V2.md.
	"IDEMPOTENCY_REPLAY",
	"PRECONDITION_FAILED",

	// BLAST-RADIUS.md, "Error cases".
	"REPO_NOT_FOUND",
	"REPO_NO_ACCESS",
	"CONNECTION_REVOKED",
	"POLICY_FORBIDS_TARGET",
	"BRANCH_NOT_FOUND",
	"EMPTY_REPOSITORY",
	"TREE_TOO_LARGE",
	"BLAST_RADIUS_VIOLATION",
	"PREVIEW_STALE",
	"PREVIEW_REQUIRED",
	"DETERMINISM_VIOLATION",
	"EXTERNAL_GITHUB",

	// Decided by the operator: GitHub refused the request. Unlike
	// EXTERNAL_GITHUB, retrying the same request will not help.
	"GITHUB_REJECTED",

	// DATA-CONTRACTS-V2.md, Dispatch: agent access (module 6). The bearer
	// token's dispatch is not running, or no dispatch has that token.
	"DISPATCH_CLOSED",
	// The agent's families do not allow this route's verb.
	"AGENT_NOT_PERMITTED",
]);

export type ErrorCode = z.infer<typeof errorCode>;

/**
 * Every HTTP status an error envelope can arrive with. Every route declares
 * all of them (commonResponses in src/contract/index.ts), so a typed client
 * never meets an undeclared status. A server test fails if the server can
 * emit a status that is not listed here.
 */
export const ERROR_STATUSES = [400, 401, 403, 404, 409, 422, 500, 502] as const;

export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/**
 * Typed details. A code listed here carries a details schema in the error
 * envelope, and ApiError's constructor refuses, at compile time, details that
 * do not match it. Every other code keeps details open (unknown, optional).
 */

/** Why a state precondition failed. Closed: it grows only by an edit here, with a heads-up. */
export const PRECONDITION_REASONS = [
	"client_not_found",
	"client_closed",
	"client_has_active_engagements",
	"engagement_not_found",
	"engagement_closed",
	"intake_check_failed",
	"intake_cut_not_derived",
	"skill_source_not_found",
	"skill_source_in_use",
	"skill_capability_mismatch",
	"mission_not_editable",
	"agent_template_not_found",
	"template_not_rosterable",
	"preset_not_found",
	"roster_not_empty",
	"skill_not_found",
	"skill_not_attachable",
	"intake_repo_mismatch",
	"intake_conventions_low_confidence",
	"connection_not_found",
	"connection_expired",
	"connection_scope_mismatch",
	"connection_credential_missing",
	"plan_changes_approved_brief",
	"preset_misses_first_wave",
	"playbook_in_use",
	"access_override_invalid",
	"template_type_mismatch",
	"identity_over_token_cap",
	"identity_role_unsupported",
	"agent_roles_cross_sides",
	"agent_role_not_assignable",
	// Module 6: starting and halting missions.
	"mission_not_draft",
	"mission_not_active",
	"plan_check_failed",
	"coherence_blocked",
	"estimate_missing",
	"spend_ceiling_missing",
	"spend_ceiling_reached",
	// An active mission's ceiling may only go up (PATCH /api/missions/:id).
	"spend_ceiling_not_raised",
	// Module 6: dispatches.
	"roster_entry_not_found",
	"roster_entry_inactive",
	"agent_identity_missing",
	"dispatch_not_queued",
	"dispatch_not_running",
	"model_price_unknown",
	"harness_unavailable",
	// Module 7: the room's source cannot be resolved; retrying will not help.
	"source_unavailable",
	"room_unavailable",
	// Module 8: completion reports.
	"report_dispatch_mismatch",
	"writes_outside_mount",
	// Step 9: a requirement the dispatch is for has no check outside the agent.
	"requirement_unchecked",
	// Canon (2026-10-19): an intake with an open Canon question is not approved.
	"intake_questions_open",
	// Brief sources (J, 2026-10-21): approval waits on the operator's confirmation of every source.
	"brief_sources_unconfirmed",
	// Module 9: a finding moves out of open once, by the operator.
	"finding_not_open",
	// Module 9: the gate run (POST /api/missions/:id/gate).
	"dispatches_running",
	"integration_conflict",
	"nothing_to_judge",
	"dispatch_commit_missing",
	// Canon's routes (2026-10-19).
	"intake_not_draft",
	"canon_session_open",
	"canon_session_not_open",
	"canon_turn_running",
	// Canon chat (2026-10-20): a mode the session cannot run, and a halt that cannot be undone.
	"canon_mode_unavailable",
	"canon_session_final",
	"canon_question_not_open",
	"client_memory_not_proposed",
	"client_memory_removed",
	// Modules 10 and 11, slice 1 (2026-10-22): exports. The gate run to ship.
	"gate_not_run",
	"gate_run_not_latest",
	"gate_pass_not_verified",
	"gate_failed",
	// The linked preview.
	"preview_mission_mismatch",
	"preview_target_mismatch",
	"package_hash_version_mismatch",
	// Render: the integration commit, and what the package may hold.
	"integration_commit_moved",
	"package_symlink",
	"package_submodule",
	"package_mode_only",
	"package_unsupported_mode",
	"package_path_not_utf8",
	"package_reserved_path",
	"package_unsafe_path",
	"package_duplicate_path",
	"package_too_large",
	// Where it goes: an internal mission has no client repository, and GitHub delivery is slice 2.
	"export_target_repo_missing",
	"export_target_not_built",
] as const;

export const preconditionReason = z.enum(PRECONDITION_REASONS);

export type PreconditionReason = z.infer<typeof preconditionReason>;

/** PRECONDITION_FAILED: always present. */
export const preconditionDetails = z
	.object({
		reason: preconditionReason,
		/** The client the precondition was about, where there is one. */
		clientId: z.string().uuid().optional(),
		/** The engagement the precondition was about, where there is one. */
		engagementId: z.string().uuid().optional(),
		/** The connection the precondition was about, where there is one. */
		connectionId: z.string().uuid().optional(),
		/** The mission the precondition was about, where there is one. */
		missionId: z.string().uuid().optional(),
		/** The dispatch the precondition was about, where there is one. */
		dispatchId: z.string().uuid().optional(),
		/** roster_entry_not_found, roster_entry_inactive, agent_identity_missing, estimate_missing, template_not_rosterable: the entries at fault, in roster order. */
		rosterEntryIds: z.array(z.string().uuid()).optional(),
		/** model_price_unknown: the model with no price. */
		model: z.string().optional(),
		/**
		 * coherence_blocked: the earliest wave the playbook declares, which no
		 * active agent is in; null when it declares none. Written out rather
		 * than imported, to keep this module free of cycles; a test pins it
		 * to WAVES.
		 */
		wave: z.enum(["A", "B", "C", "D", "E"]).nullable().optional(),
		/** agent_roles_cross_sides: the sides the roles span, in SIDES order. */
		sides: z.array(z.enum(SIDES)).optional(),
		/** identity_over_token_cap: the generated file that went over. */
		file: z.enum(["identity", "depth"]).optional(),
		/** identity_over_token_cap: that file's estimated tokens. */
		tokens: z.number().int().nonnegative().optional(),
		/** identity_over_token_cap: the cap it went over. */
		cap: z.number().int().positive().optional(),
		/** What a mechanical check found (intake_check_failed, intake_questions_open, brief_sources_unconfirmed, access_override_invalid, agent_role_not_assignable, plan_check_failed, coherence_blocked, writes_outside_mount, source_unavailable, requirement_unchecked) or what a plan changed (plan_changes_approved_brief), in a stable order. */
		issues: z
			.array(
				z
					.object({
						path: z.array(z.union([z.string(), z.number()])),
						message: z.string(),
					})
					.strict(),
			)
			.optional(),
	})
	.strict();

export type PreconditionDetails = z.infer<typeof preconditionDetails>;

export const validationIssue = z
	.object({
		path: z.array(z.union([z.string(), z.number()])),
		message: z.string(),
		/** The validator's issue code, where one exists (Zod's, for contract validation). */
		code: z.string().optional(),
	})
	.strict();

export type ValidationIssue = z.infer<typeof validationIssue>;

/** VALIDATION_FAILED: optional, absent when the body was not JSON at all. */
export const validationDetails = z
	.object({
		params: z.array(validationIssue).optional(),
		headers: z.array(validationIssue).optional(),
		query: z.array(validationIssue).optional(),
		body: z.array(validationIssue).optional(),
	})
	.strict();

export type ValidationDetails = z.infer<typeof validationDetails>;

/** The codes that carry a details schema. */
export const TYPED_DETAIL_CODES = [
	"PRECONDITION_FAILED",
	"VALIDATION_FAILED",
] as const;

/** The details type for a code. */
export type ErrorDetails<C extends ErrorCode> = C extends "PRECONDITION_FAILED"
	? PreconditionDetails
	: C extends "VALIDATION_FAILED"
		? ValidationDetails
		: unknown;

/** The details argument for a code: required where the schema requires it. */
export type ErrorDetailsArgs<C extends ErrorCode> =
	C extends "PRECONDITION_FAILED"
		? [details: PreconditionDetails]
		: [details?: ErrorDetails<C>];
