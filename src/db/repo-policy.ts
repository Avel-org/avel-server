import { and, eq } from "drizzle-orm";
import { repoPolicy } from "./schema";
import { live } from "./schema/columns";
import type { Executor } from "./tx";

/**
 * A repository's RepoPolicy key: https://github.com/<owner>/<repo>, lowercased,
 * since GitHub names are case-insensitive. Policies are stored and looked up
 * by it, so one repository has one live row however its URL was written.
 */
export function repoPolicyUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}`.toLowerCase();
}

/**
 * Whether the repository's live policy allows a push to its default branch.
 * No row is false: the safe behaviour needs no setup (DATA-CONTRACTS-V2.md).
 */
export async function directPushAllowed(
	db: Executor,
	owner: string,
	repo: string,
): Promise<boolean> {
	const [row] = await db
		.select({ allow: repoPolicy.allowDirectPushToDefault })
		.from(repoPolicy)
		.where(
			and(eq(repoPolicy.repoUrl, repoPolicyUrl(owner, repo)), live(repoPolicy)),
		);
	return row?.allow ?? false;
}
