import { z } from "zod";

/**
 * One step of a run, as the run trace renders it: Canon's turns now, a
 * dispatch's run next, in the same shape so one component shows both
 * (J, 2026-10-20). Steps are append-only and read after a seq, as messages
 * are; a tool call and its result are two steps, linked by detail.callSeq.
 * Reasoning is the summary the API returns, never raw.
 */
export const RUN_STEP_KINDS = [
	"reasoning_summary",
	"tool_call",
	"tool_result",
	"text",
	"error",
] as const;

export const runStepKind = z.enum(RUN_STEP_KINDS);

export const runStep = z.object({
	id: z.string().uuid(),
	/** The order, from 1, per session or dispatch. */
	seq: z.number().int().positive(),
	/** Canon: the seq of the operator message that started the turn. Null for a dispatch. */
	turn: z.number().int().positive().nullable(),
	kind: runStepKind,
	/** Short and human, at most 80 characters. */
	label: z.string(),
	detail: z.record(z.string(), z.unknown()),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().nullable(),
	/** Approximate: usage arrives per model message, not per step. */
	tokensIn: z.number().int().nonnegative().nullable(),
	tokensOut: z.number().int().nonnegative().nullable(),
});

export type RunStep = z.infer<typeof runStep>;

/** GET .../steps: steps after a seq, oldest first, and the highest seq so far. */
export const runStepsQuery = z.object({
	/** Only steps after this seq: 0 or omitted for all. */
	afterSeq: z.coerce.number().int().nonnegative().default(0),
	limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const runStepsEnvelope = z.object({
	success: z.literal(true),
	data: z.array(runStep),
	meta: z.object({ lastSeq: z.number().int().nonnegative() }),
});
