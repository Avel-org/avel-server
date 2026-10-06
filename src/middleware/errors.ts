import {
	RequestValidationError,
	TsRestHttpError,
} from "@ts-rest/serverless/fetch";
import type { ZodError } from "zod";
import { type ErrorCode, type ErrorEnvelope, fail } from "../contract";
import type { Logger } from "../lib/logger";

/**
 * The status each code answers with unless the thrower says otherwise. A
 * Record keyed on the union, so adding a code fails the build until it has
 * a status here.
 */
export const statusFor: Record<ErrorCode, number> = {
	VALIDATION_FAILED: 400,
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	INTERNAL: 500,
	IDEMPOTENCY_REPLAY: 409,
	PRECONDITION_FAILED: 422,
	REPO_NOT_FOUND: 404,
	REPO_NO_ACCESS: 403,
	CONNECTION_REVOKED: 422,
	POLICY_FORBIDS_TARGET: 403,
	BRANCH_NOT_FOUND: 404,
	EMPTY_REPOSITORY: 422,
	TREE_TOO_LARGE: 502,
	BLAST_RADIUS_VIOLATION: 422,
	PREVIEW_STALE: 409,
	PREVIEW_REQUIRED: 422,
	DETERMINISM_VIOLATION: 422,
	EXTERNAL_GITHUB: 502,
	GITHUB_REJECTED: 502,
};

/**
 * The one error a handler throws on purpose. Its code and message reach the
 * client. Anything else thrown reaches the client only as INTERNAL.
 */
export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly details: unknown;

	constructor(
		code: ErrorCode,
		message: string,
		options: { status?: number; details?: unknown } = {},
	) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = options.status ?? statusFor[code];
		this.details = options.details;
	}
}

/** Receives every failure the client sees as a 5xx, with its request id. */
export type ErrorReporter = (err: unknown, requestId: string) => void;

/** Logs each 5xx at error level with its request id, so a client's report can be traced. */
export function loggerReporter(logger: Logger): ErrorReporter {
	return (err, requestId) => {
		logger.error({ err, requestId }, "request failed");
	};
}

/** The request id used when the id generator itself is what failed. */
export const UNAVAILABLE_REQUEST_ID = "unavailable";

/**
 * Turns anything thrown under /api/* into a status and an error envelope.
 * Stack traces and messages of unexpected errors go to the reporter, never
 * to the client.
 */
export function toErrorEnvelope(
	err: unknown,
	requestId: string,
	report: ErrorReporter,
): { status: number; body: ErrorEnvelope } {
	if (err instanceof ApiError) {
		if (err.status >= 500) report(err, requestId);
		return {
			status: err.status,
			body: fail(err.code, err.message, requestId, err.details),
		};
	}
	if (err instanceof RequestValidationError) {
		return {
			status: 400,
			body: fail(
				"VALIDATION_FAILED",
				"The request does not match the contract",
				requestId,
				{
					...issuesOf("params", err.pathParamsError),
					...issuesOf("headers", err.headersError),
					...issuesOf("query", err.queryError),
					...issuesOf("body", err.bodyError),
				},
			),
		};
	}
	report(err, requestId);
	return {
		status: 500,
		body: fail("INTERNAL", "Internal server error", requestId),
	};
}

/** ts-rest signals an unmatched route with a 404 TsRestHttpError. */
export function isRouteNotFound(err: unknown): boolean {
	return err instanceof TsRestHttpError && err.statusCode === 404;
}

function issuesOf(part: string, error: ZodError | null) {
	if (!error) return {};
	return {
		[part]: error.issues.map((issue) => ({
			path: issue.path,
			message: issue.message,
			code: issue.code,
		})),
	};
}
