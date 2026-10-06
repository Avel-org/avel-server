import { z } from "zod";
import { type ErrorCode, errorCode } from "./errors";

/**
 * Every JSON response under /api/* is one of two envelopes, told apart by
 * `success`. The frontend switches on `error.code`, never on `message`.
 */
export const errorEnvelope = z.object({
	success: z.literal(false),
	error: z.object({
		code: errorCode,
		message: z.string(),
		details: z.unknown().optional(),
		requestId: z.string(),
	}),
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

export function fail(
	code: ErrorCode,
	message: string,
	requestId: string,
	details?: unknown,
): ErrorEnvelope {
	return {
		success: false,
		error:
			details === undefined
				? { code, message, requestId }
				: { code, message, details, requestId },
	};
}
