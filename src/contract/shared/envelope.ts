import { z } from "zod";
import {
	type ErrorCode,
	type ErrorDetailsArgs,
	errorCode,
	preconditionDetails,
	TYPED_DETAIL_CODES,
	validationDetails,
} from "./errors";

/**
 * Every JSON response under /api/* is one of two envelopes, told apart by
 * `success`. The frontend switches on `error.code`, never on `message`.
 *
 * The error is a discriminated union on `code`: PRECONDITION_FAILED and
 * VALIDATION_FAILED carry typed details (TYPED_DETAIL_CODES); every other
 * code keeps details open.
 */
const errorFields = { message: z.string(), requestId: z.string() };

export const errorEnvelope = z.object({
	success: z.literal(false),
	error: z.discriminatedUnion("code", [
		z.object({
			code: z.literal("PRECONDITION_FAILED"),
			...errorFields,
			details: preconditionDetails,
		}),
		z.object({
			code: z.literal("VALIDATION_FAILED"),
			...errorFields,
			details: validationDetails.optional(),
		}),
		z.object({
			code: errorCode.exclude([...TYPED_DETAIL_CODES]),
			...errorFields,
			details: z.unknown().optional(),
		}),
	]),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

export const envelopeMeta = z.record(z.string(), z.unknown());

export type EnvelopeMeta = z.infer<typeof envelopeMeta>;

/** The success envelope around a route's data shape. */
export function successEnvelope<T extends z.ZodTypeAny>(data: T) {
	return z.object({
		success: z.literal(true),
		data,
		meta: envelopeMeta.optional(),
	});
}

export type SuccessEnvelope<T> = {
	success: true;
	data: T;
	meta?: EnvelopeMeta;
};

export function ok<T>(data: T, meta?: EnvelopeMeta): SuccessEnvelope<T> {
	return meta === undefined
		? { success: true, data }
		: { success: true, data, meta };
}

/**
 * Builds an error envelope. Its details argument is typed by `code`, so a
 * wrong shape is a compile error; the schema above checks it again in tests.
 */
export function fail<C extends ErrorCode>(
	code: C,
	message: string,
	requestId: string,
	...[details]: ErrorDetailsArgs<C>
): ErrorEnvelope {
	return {
		success: false,
		error:
			details === undefined
				? { code, message, requestId }
				: { code, message, details, requestId },
	} as ErrorEnvelope;
}
