import { z } from "zod";

/**
 * The bounds of the canon_question CHECKs (src/db/schema/canon.ts), here so
 * a test can compare the two: canon_question_header_length and
 * canon_question_options_two_to_four.
 */
export const QUESTION_HEADER_MIN = 1;
export const QUESTION_HEADER_MAX = 12;
export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 4;

const CHUNK_ID = /^[0-9a-f]{64}:([1-9][0-9]*)-([1-9][0-9]*)$/;

/** Counted as Postgres char_length counts: code points, not UTF-16 units. */
const characters = (s: string) => [...s].length;

const text = z.string().trim().min(1);

const option = z.object({ label: text, description: text }).strict();

/**
 * The input of Canon's `ask_operator` tool. Text is trimmed before it is
 * measured or stored; the header is 1 to 12 characters after that.
 */
export const askOperatorInput = z
	.object({
		header: z
			.string()
			.trim()
			.refine(
				(h) => {
					const n = characters(h);
					return n >= QUESTION_HEADER_MIN && n <= QUESTION_HEADER_MAX;
				},
				{
					message: `A header is ${QUESTION_HEADER_MIN} to ${QUESTION_HEADER_MAX} characters`,
				},
			),
		question: text,
		options: z
			.array(option)
			.min(QUESTION_OPTIONS_MIN)
			.max(QUESTION_OPTIONS_MAX)
			.superRefine((options, ctx) => {
				const seen = new Set<string>();
				options.forEach((o, i) => {
					if (seen.has(o.label)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: [i, "label"],
							message: `${o.label} is listed twice`,
						});
					}
					seen.add(o.label);
				});
			}),
		multiSelect: z.boolean(),
		reason: text,
		/** Chunk ids from splitKnowledge: `<sha256>:<startLine>-<endLine>`. */
		sourceChunkIds: z.array(
			z.string().refine(
				(id) => {
					const m = CHUNK_ID.exec(id);
					return m !== null && Number(m[1]) <= Number(m[2]);
				},
				{ message: "A chunk id is <sha256>:<startLine>-<endLine>" },
			),
		),
	})
	.strict();

export type AskOperatorInput = z.infer<typeof askOperatorInput>;
