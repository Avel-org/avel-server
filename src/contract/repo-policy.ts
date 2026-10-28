import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { exportTargetKind } from "./mission";
import { successEnvelope } from "./shared/envelope";
import { pageMeta, pageQuery } from "./shared/pagination";

const c = initContract();

const uuid = z.string().uuid();
const iso = z.string().datetime();

/**
 * What a repository allows (DATA-CONTRACTS-V2.md, RepoPolicy). A repository
 * with no policy allows no push to its default branch: the safe behaviour
 * needs no setup, and only the permissive one is opt-in.
 */
export const repoPolicySchema = z.object({
	id: uuid,
	/** https://github.com/<owner>/<repo>, lowercased. */
	repoUrl: z.string(),
	label: z.string().nullable(),
	allowDirectPushToDefault: z.boolean(),
	defaultTarget: exportTargetKind.nullable(),
	createdAt: iso,
	updatedAt: iso,
});

export type RepoPolicy = z.infer<typeof repoPolicySchema>;

const GITHUB_REPO =
	/^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/?$/;

/**
 * Sets one repository's policy, creating it when there is none. Turning on
 * a direct push to the default branch (off or no policy, to on) needs
 * confirmDirectPush: true, so it is a deliberate act and never a toggle a
 * stray request flips (ROUTES.md, /settings/repositories). The server
 * refuses it otherwise. A set that leaves it on, or turns it off, needs none.
 */
export const setRepoPolicyBody = z
	.object({
		repoUrl: z
			.string()
			.trim()
			.regex(GITHUB_REPO, "A GitHub repository: https://github.com/owner/repo"),
		label: z.string().trim().min(1).max(200).nullable().optional(),
		allowDirectPushToDefault: z.boolean(),
		defaultTarget: exportTargetKind.nullable().optional(),
		confirmDirectPush: z.literal(true).optional(),
	})
	.strict();

export const repoPolicyListEnvelope = z.object({
	success: z.literal(true),
	data: z.array(repoPolicySchema),
	meta: pageMeta.extend({
		/** The exact number of live policies, ignoring the cursor. */
		total: z.number().int().nonnegative(),
	}),
});

/** Operator only. Canon and agents reach neither route (DECISIONS-V2.md: Canon must never touch RepoPolicy). */
export const repoPolicyContract = c.router({
	list: {
		method: "GET",
		path: "/api/repo-policies",
		query: pageQuery,
		responses: { 200: repoPolicyListEnvelope },
		summary:
			"Repository policies, newest first. A repository with none allows no direct push.",
	},
	set: {
		method: "PUT",
		path: "/api/repo-policies",
		body: setRepoPolicyBody,
		responses: { 200: successEnvelope(repoPolicySchema) },
		summary:
			"Set a repository's policy. Allowing a direct push to its default branch needs confirmDirectPush.",
	},
});
