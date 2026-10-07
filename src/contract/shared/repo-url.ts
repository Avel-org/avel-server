/**
 * A GitHub repository URL, parsed and normalized. GitHub treats owner and
 * repo names case-insensitively, so the normalized form is lowercase, with
 * no .git suffix and no trailing slash: https://github.com/meridian-co/app.
 * Anything else is null. Read-repo stores this form and approve compares
 * against it, so two spellings of one repository match.
 */
export type GitHubRepo = { owner: string; repo: string; url: string };

const GITHUB_REPO_URL =
	/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export function parseGitHubRepoUrl(input: string): GitHubRepo | null {
	const m = GITHUB_REPO_URL.exec(input.trim());
	if (!m?.[1] || !m[2] || m[2] === "." || m[2] === "..") return null;
	const owner = m[1].toLowerCase();
	const repo = m[2].toLowerCase();
	return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
