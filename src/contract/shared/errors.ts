import { z } from "zod";

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
