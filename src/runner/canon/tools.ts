import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { wave } from "../../contract/agent-template";
import { createPresetBody } from "../../contract/preset";
import {
	type CanonProposalPremise,
	type PlaybookProposalPayload,
	type PresetProposalPayload,
	playbookProposalFields,
	presetChoiceIssue,
} from "../../contract/proposal";
import { earliestWave } from "../../contract/shared/coherence";
import { logActivity } from "../../db/activity";
import type { ClientId } from "../../db/client-id";
import {
	canonQuestion,
	canonSession,
	clientMemory,
	intake,
	playbook,
	proposal,
} from "../../db/schema";
import { live, stamp, touch } from "../../db/schema/columns";
import { type Tx, withClientScope } from "../../db/tx";
import {
	briefSourceIssues,
	carryConfirmations,
	withChunkIds,
} from "../../lib/brief-sources";
import { askOperatorInput } from "../../lib/canon";
import type { Clock } from "../../lib/clock";
import type { IdGenerator } from "../../lib/ids";
import { type CheckIssue, checkIntake } from "../../lib/intake-check";
import { ApiError } from "../../middleware/errors";
import { requireUsablePreset } from "../../routes/playbooks";
import { requirePresetAgents } from "../../routes/roster";
import type { DraftToolCall, DraftToolName, ToolResult } from "./model";

/**
 * Canon's tools, in process (DATA-CONTRACTS-V2, Canon's entities). Each
 * closes over one session. The intake, the client and the engagement come
 * from the session row, never from the model, and every write runs in that
 * client's scope. A tool refuses once the session is no longer open or its
 * turn has ended. Activity payloads hold ids, statuses and counts only.
 */

export type CanonToolContext = {
	db: () => import("../../db/tx").Executor;
	clock: Clock;
	ids: IdGenerator;
	clientId: ClientId;
	session: { id: string; intakeId: string; engagementId: string };
	/** The chunk ids of this turn's knowledge: a question may cite only these. */
	chunkIds: ReadonlySet<string>;
	/** One per turn, for the activity rows. */
	requestId: string;
};

const MEMORY_MAX_CHARS = 4000;

export const draftBriefInput = z
	.object({ brief: z.record(z.string(), z.unknown()) })
	.strict();

export const proposeMemoryInput = z
	.object({ contentMd: z.string().trim().min(1).max(MEMORY_MAX_CHARS) })
	.strict();

const text = z.string().trim().min(1);

export const recommendRosterInput = z
	.object({
		agents: z
			.array(
				z
					.object({
						agentTemplateId: z.string().uuid(),
						waves: z.array(wave).min(1),
						territory: text.nullable(),
						writablePaths: z.array(text).nullable(),
						estimatedTokens: z.number().int().positive().nullable(),
						reason: text,
					})
					.strict(),
			)
			.min(1)
			.max(30),
	})
	.strict();

/**
 * A playbook for the operator to approve (J, 2026-10-28: Canon drafts, the
 * operator approves). It names a live preset or carries a new one.
 */
export const draftPlaybookInput = z
	.object({ ...playbookProposalFields, reason: text })
	.strict();

/** A new preset for the operator to approve. */
export const draftPresetInput = z
	.object({ preset: createPresetBody, reason: text })
	.strict();

const error = (message: string): ToolResult => ({
	text: message,
	isError: true,
});

function issuesText(
	issues: readonly { path: PropertyKey[]; message: string }[],
) {
	return issues
		.map((i) => `- ${i.path.map(String).join(".") || "(input)"}: ${i.message}`)
		.join("\n");
}

class Refused extends Error {}

export function canonTools(ctx: CanonToolContext): DraftToolCall {
	const actor = {
		actorKind: "canon" as const,
		actorCanonSessionId: ctx.session.id,
	};
	const logged = {
		engagementId: ctx.session.engagementId,
		clientId: ctx.clientId,
		requestId: ctx.requestId,
	};

	/** Runs `fn` in the client's scope once the session is open mid-turn; a refusal becomes the tool's error. */
	async function inTurn(
		fn: (tx: Tx) => Promise<ToolResult>,
	): Promise<ToolResult> {
		try {
			return await withClientScope(ctx.db(), ctx.clientId, async (tx) => {
				const [s] = await tx
					.select({
						status: canonSession.status,
						turnStartedAt: canonSession.turnStartedAt,
					})
					.from(canonSession)
					.where(eq(canonSession.id, ctx.session.id))
					.for("update");
				if (!s || s.status !== "open" || s.turnStartedAt === null) {
					throw new Refused("This turn is over; nothing was written.");
				}
				return fn(tx);
			});
		} catch (err) {
			if (err instanceof Refused) return error(err.message);
			if (err instanceof ApiError) return error(err.message);
			throw err;
		}
	}

	/** The intake, locked, when it is still a draft; otherwise a refusal. */
	async function draftIntake(tx: Tx) {
		const [row] = await tx
			.select({
				status: intake.status,
				openQuestions: intake.openQuestions,
				proposedBrief: intake.proposedBrief,
			})
			.from(intake)
			.where(eq(intake.id, ctx.session.intakeId))
			.for("update");
		if (!row || row.status !== "draft") {
			throw new Refused(
				`The intake is ${row?.status ?? "missing"}, not a draft; nothing was written.`,
			);
		}
		return row;
	}

	/** A pending proposal from this session, and its proposal.created row. */
	async function propose(
		tx: Tx,
		draft:
			| { kind: "playbook"; payload: PlaybookProposalPayload }
			| { kind: "preset"; payload: PresetProposalPayload },
		summary: string,
		reason: string,
		counts: Record<string, number | null>,
	): Promise<void> {
		const id = ctx.ids.next();
		const premise: CanonProposalPremise = {
			canonSessionId: ctx.session.id,
			intakeId: ctx.session.intakeId,
			reason,
		};
		await tx.insert(proposal).values({
			id,
			kind: draft.kind,
			source: "model",
			engagementId: ctx.session.engagementId,
			missionId: null,
			summary,
			payload: draft.payload,
			premise,
			status: "pending",
			reason: null,
			decidedBy: null,
			decidedAt: null,
			...stamp(ctx.clock),
		});
		await logActivity(tx, ctx, {
			...actor,
			...logged,
			action: "proposal.created",
			entityType: "proposal",
			entityId: id,
			payload: { canonSessionId: ctx.session.id, kind: draft.kind, ...counts },
		});
	}

	const tools: Record<DraftToolName, (input: unknown) => Promise<ToolResult>> =
		{
			ask_operator: async (input) => {
				const parsed = askOperatorInput.safeParse(input);
				if (!parsed.success) return error(issuesText(parsed.error.issues));
				const q = parsed.data;
				const unknown = q.sourceChunkIds.filter((c) => !ctx.chunkIds.has(c));
				if (unknown.length > 0) {
					return error(
						`No passage in this project's documents is ${unknown.join(", ")}.`,
					);
				}
				return inTurn(async (tx) => {
					const id = ctx.ids.next();
					await tx.insert(canonQuestion).values({
						id,
						intakeId: ctx.session.intakeId,
						canonSessionId: ctx.session.id,
						clientId: ctx.clientId,
						header: q.header,
						question: q.question,
						options: q.options,
						multiSelect: q.multiSelect,
						reason: q.reason,
						sourceChunkIds: q.sourceChunkIds,
						status: "open",
						answer: null,
						effectMd: null,
						decidedBy: null,
						decidedAt: null,
						...stamp(ctx.clock),
					});
					await logActivity(tx, ctx, {
						...actor,
						...logged,
						action: "canon_question.asked",
						entityType: "canon_question",
						entityId: id,
						payload: {
							canonSessionId: ctx.session.id,
							intakeId: ctx.session.intakeId,
							optionCount: q.options.length,
							multiSelect: q.multiSelect,
							sourceChunkCount: q.sourceChunkIds.length,
						},
					});
					return {
						text: "Asked. The operator will answer; their answer reaches you next turn.",
					};
				});
			},

			draft_brief: async (input) => {
				const parsed = draftBriefInput.safeParse(input);
				if (!parsed.success) return error(issuesText(parsed.error.issues));
				const brief = withChunkIds(parsed.data.brief);
				const unknownSources = briefSourceIssues(
					brief,
					(c) => ctx.chunkIds.has(c),
					["brief"],
				);
				if (unknownSources.length > 0) {
					return error(
						`Cite only the passages you were given: ${unknownSources
							.map((i) => `${i.path.join(".")}: ${i.message}`)
							.join("; ")}`,
					);
				}
				for (const key of ["modules", "checks"] as const) {
					const value = brief[key];
					if (
						value !== undefined &&
						!(Array.isArray(value) && value.length === 0)
					) {
						return error(
							`Write no ${key}: the plan comes later, from the operator.`,
						);
					}
				}
				return inTurn(async (tx) => {
					const row = await draftIntake(tx);
					// Canon cannot confirm a passage; an unchanged item keeps the
					// operator's confirmation.
					const stored = carryConfirmations(row.proposedBrief, brief);
					// The derived_* fields come from reading the repository; never these.
					await tx
						.update(intake)
						.set({
							proposedBrief: stored,
							draftedByCanonSessionId: ctx.session.id,
							...touch(ctx.clock),
						})
						.where(eq(intake.id, ctx.session.intakeId));
					const issues: CheckIssue[] = checkIntake({
						proposedBrief: stored,
						openQuestions: row.openQuestions,
					});
					await logActivity(tx, ctx, {
						...actor,
						...logged,
						action: "intake.drafted_by_canon",
						entityType: "intake",
						entityId: ctx.session.intakeId,
						payload: {
							canonSessionId: ctx.session.id,
							issueCount: issues.length,
						},
					});
					return {
						text:
							issues.length === 0
								? "Saved. The intake check found no issues."
								: `Saved. The intake check found ${issues.length} issues:\n${issuesText(issues)}`,
					};
				});
			},

			propose_memory: async (input) => {
				const parsed = proposeMemoryInput.safeParse(input);
				if (!parsed.success) return error(issuesText(parsed.error.issues));
				return inTurn(async (tx) => {
					const id = ctx.ids.next();
					await tx.insert(clientMemory).values({
						id,
						clientId: ctx.clientId,
						contentMd: parsed.data.contentMd,
						status: "proposed",
						proposedByCanonSessionId: ctx.session.id,
						decidedBy: null,
						decidedAt: null,
						...stamp(ctx.clock),
					});
					await logActivity(tx, ctx, {
						...actor,
						...logged,
						action: "client_memory.proposed",
						entityType: "client_memory",
						entityId: id,
						payload: { canonSessionId: ctx.session.id },
					});
					return { text: "Proposed. The operator keeps it or removes it." };
				});
			},

			recommend_roster: async (input) => {
				const parsed = recommendRosterInput.safeParse(input);
				if (!parsed.success) return error(issuesText(parsed.error.issues));
				const { agents } = parsed.data;
				return inTurn(async (tx) => {
					await draftIntake(tx);
					// As a preset save would check: live, rosterable, once per territory.
					await requirePresetAgents(tx, agents);
					await tx
						.update(intake)
						.set({ recommendedRoster: { agents }, ...touch(ctx.clock) })
						.where(eq(intake.id, ctx.session.intakeId));
					await logActivity(tx, ctx, {
						...actor,
						...logged,
						action: "intake.updated",
						entityType: "intake",
						entityId: ctx.session.intakeId,
						payload: {
							canonSessionId: ctx.session.id,
							field: "recommendedRoster",
							agentCount: agents.length,
						},
					});
					return { text: "Recommended. It is shown beside the presets." };
				});
			},

			draft_playbook: async (input) => {
				const parsed = draftPlaybookInput.safeParse(input);
				if (!parsed.success) return error(issuesText(parsed.error.issues));
				const { reason, ...draft } = parsed.data;
				const choice = presetChoiceIssue(draft);
				if (choice) return error(choice);
				return inTurn(async (tx) => {
					// The checks approval will make, so the operator is never handed
					// a draft that cannot be approved as written.
					const { defaultPresetId, wavesApplicable } = draft.playbook;
					if (draft.newPreset !== null) {
						await requirePresetAgents(tx, draft.newPreset.agents);
						const first = earliestWave(draft.playbook);
						if (
							first === null ||
							!draft.newPreset.agents.some((a) => a.waves.includes(first))
						) {
							throw new Refused(
								`The new preset has no agent in wave ${first ?? "(none)"}, the earliest the playbook declares; nothing was written.`,
							);
						}
					} else if (defaultPresetId !== null) {
						await requireUsablePreset(tx, { defaultPresetId, wavesApplicable });
					}
					const { missionType, name } = draft.playbook;
					const [current] = await tx
						.select({ version: playbook.version })
						.from(playbook)
						.where(and(eq(playbook.missionType, missionType), live(playbook)));
					const replacesVersion = current?.version ?? null;
					const withPreset =
						draft.newPreset !== null
							? `, with a new preset ${draft.newPreset.name}`
							: "";
					await propose(
						tx,
						{ kind: "playbook", payload: { ...draft, replacesVersion } },
						replacesVersion === null
							? `New playbook for ${missionType}: ${name}${withPreset}`
							: `Replace the ${missionType} playbook (version ${replacesVersion}): ${name}${withPreset}`,
						reason,
						{
							replacesVersion,
							gateCount: draft.playbook.gates.length,
							newPresetAgentCount: draft.newPreset?.agents.length ?? null,
						},
					);
					return {
						text: "Proposed. The operator approves or dismisses it in the proposal queue; nothing is live until then.",
					};
				});
			},

			draft_preset: async (input) => {
				const parsed = draftPresetInput.safeParse(input);
				if (!parsed.success) return error(issuesText(parsed.error.issues));
				const { reason, preset } = parsed.data;
				return inTurn(async (tx) => {
					// As a preset save would check: live, rosterable, once per territory.
					await requirePresetAgents(tx, preset.agents);
					await propose(
						tx,
						{ kind: "preset", payload: { preset } },
						`New preset: ${preset.name}`,
						reason,
						{ agentCount: preset.agents.length },
					);
					return {
						text: "Proposed. The operator approves or dismisses it in the proposal queue; nothing is live until then.",
					};
				});
			},
		};

	return (name, input) => tools[name](input);
}
