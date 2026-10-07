import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";

const c = initContract();

const uuid = z.string().uuid();
const iso = z.string().datetime();

/** Must equal the connection_* pgEnums; tests/api/connection.test.ts checks them. */
export const connectionService = z.enum(["github"]);
export const connectionScopeType = z.enum(["owner", "repo"]);
export const connectionStatus = z.enum(["active", "expired", "revoked"]);

/**
 * The name of an environment variable, never its value. Uppercase letters,
 * digits and underscores only: a GitHub token (ghp_..., github_pat_...) has
 * lowercase letters, so a pasted token is refused with 400 rather than
 * stored. The variable is checked at read time, not here.
 */
export const credentialRef = z
	.string()
	.regex(
		/^[A-Z][A-Z0-9_]{0,127}$/,
		"Give the name of an environment variable (for example MERIDIAN_GITHUB_TOKEN), never a token",
	);

/** An owner (meridian-co) or owner/repo (meridian-co/app), as GitHub spells them. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** One Connection. The credential appears only as its name. */
export const connectionSchema = z.object({
	id: uuid,
	service: connectionService,
	/** Null for AVEL's own internal work. */
	engagementId: uuid.nullable(),
	label: z.string(),
	scopeType: connectionScopeType,
	scopeValue: z.string(),
	credentialRef: z.string(),
	status: connectionStatus,
	expiresAt: iso.nullable(),
	lastRotatedAt: iso.nullable(),
	revokedAt: iso.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type Connection = z.infer<typeof connectionSchema>;

/** A new connection is always an active GitHub connection. */
export const createConnectionBody = z
	.object({
		engagementId: uuid.nullable(),
		label: z.string().trim().min(1).max(200),
		scopeType: connectionScopeType,
		scopeValue: z.string().trim().min(1).max(200),
		credentialRef,
		expiresAt: iso.optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		const [owner, repo, ...rest] = body.scopeValue.split("/");
		const ok =
			body.scopeType === "owner"
				? repo === undefined && OWNER.test(owner ?? "")
				: rest.length === 0 && OWNER.test(owner ?? "") && REPO.test(repo ?? "");
		if (!ok) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["scopeValue"],
				message:
					body.scopeType === "owner"
						? "An owner scope is one GitHub owner: meridian-co"
						: "A repo scope is owner/repo: meridian-co/app",
			});
		}
	});

export const connectionListQuery = pageQuery.extend({
	engagementId: uuid.optional(),
	status: connectionStatus.optional(),
});

export const connectionListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(connectionSchema),
	meta: pageMeta.extend({
		/** The exact number of connections the filters keep, ignoring the cursor. */
		total: z.number().int().nonnegative(),
	}),
});

export const connectionContract = c.router({
	list: {
		method: "GET",
		path: "/api/connections",
		query: connectionListQuery,
		responses: { 200: connectionListEnvelope },
		summary: "Connections, newest first",
	},
	get: {
		method: "GET",
		path: "/api/connections/:id",
		pathParams: z.object({ id: uuid }),
		responses: { 200: successEnvelope(connectionSchema) },
	},
	create: {
		method: "POST",
		path: "/api/connections",
		body: createConnectionBody,
		responses: { 201: successEnvelope(connectionSchema) },
		summary:
			"An active GitHub connection. credentialRef names an env var; the token is never sent or stored.",
	},
});
