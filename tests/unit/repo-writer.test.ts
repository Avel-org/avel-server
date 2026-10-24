import { describe, expect, it } from "vitest";
import {
	githubRepoWriter,
	type PullRequestRequest,
} from "../../src/gateways/repo-writer";
import { gitBlobSha } from "../../src/lib/export/blob";

// The GitHub write path (EXPORT-ENGINE.md §8, §13) against a fake GitHub:
// Octokit's own requests, answered in the shapes GitHub's REST docs give for
// each endpoint. Provenance: written from docs.github.com/rest/git and
// /rest/pulls, not recorded; record them against a scratch repository once
// one exists (§13).

const BASE_COMMIT = "c".repeat(40);
const BASE_TREE = "7".repeat(40);
const NEW_TREE = "8".repeat(40);
const NEW_COMMIT = "9".repeat(40);

type Call = {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
};

/** A fake GitHub. `over` answers a "METHOD path" with a status, or a blob sha to send back. */
function fakeGitHub(
	over: Record<string, number> = {},
	opts: {
		wrongBlobSha?: boolean;
		pulls?: unknown[];
		/** Headers on an `over` answer, such as GitHub's rate-limit ones. */
		headers?: Record<string, string>;
	} = {},
) {
	const calls: Call[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		const method = (init?.method ?? "GET").toUpperCase();
		const path = url.pathname.replace(/^\/repos\/acme\/app/, "");
		const body =
			typeof init?.body === "string"
				? (JSON.parse(init.body) as Record<string, unknown>)
				: null;
		calls.push({ method, path: path + url.search, body });
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 1));
		inFlight -= 1;
		const json = (
			status: number,
			data: unknown,
			extra: Record<string, string> = {},
		) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "content-type": "application/json", ...extra },
			});
		const key = `${method} ${path}`;
		if (over[key]) {
			return json(over[key], { message: "refused" }, opts.headers);
		}
		if (key === "POST /git/blobs") {
			const bytes = Buffer.from(String(body?.content), "base64");
			const sha = opts.wrongBlobSha ? "0".repeat(40) : gitBlobSha(bytes);
			return json(201, { sha, url: "" });
		}
		if (key === `GET /git/commits/${BASE_COMMIT}`) {
			return json(200, { sha: BASE_COMMIT, tree: { sha: BASE_TREE } });
		}
		if (key === "POST /git/trees") return json(201, { sha: NEW_TREE });
		if (key === "POST /git/commits") return json(201, { sha: NEW_COMMIT });
		if (key === "POST /git/refs") {
			return json(201, { ref: body?.ref, object: { sha: NEW_COMMIT } });
		}
		if (key === "POST /pulls") {
			return json(201, {
				number: 42,
				html_url: "https://github.com/acme/app/pull/42",
			});
		}
		if (key === "GET /pulls") return json(200, opts.pulls ?? []);
		return json(404, { message: `no fake for ${key}` });
	}) as typeof globalThis.fetch;
	return { fetch: fake, calls, maxInFlight: () => maxInFlight };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string, mode = "100644") => ({
	path,
	mode,
	bytes: bytes(text),
	blobSha: gitBlobSha(bytes(text)),
});

const request = (
	over: Partial<PullRequestRequest> = {},
): PullRequestRequest => ({
	owner: "acme",
	repo: "app",
	credentialRef: "ACME_TOKEN",
	base: { branch: "main", commitSha: BASE_COMMIT },
	head: "avel/12345678-s1-abcdefabcdef",
	files: [file("src/a.ts", "a\n"), file("bin/run", "#!/bin/sh\n", "100755")],
	deletes: ["src/old.ts"],
	message: "AVEL: booking sprint 1",
	title: "AVEL: booking sprint 1",
	body: "Delivered by AVEL",
	...over,
});

const writer = (fetch: typeof globalThis.fetch) =>
	githubRepoWriter({
		env: (n) => (n === "ACME_TOKEN" ? "t" : undefined),
		fetch,
	});

describe("githubRepoWriter.openPullRequest", () => {
	it("writes each blob, one at a time, then a tree on the base commit's tree, a commit, a new branch and the PR", async () => {
		const gh = fakeGitHub();
		const pr = await writer(gh.fetch).openPullRequest(request());
		expect(pr).toEqual({
			number: 42,
			url: "https://github.com/acme/app/pull/42",
			branch: "avel/12345678-s1-abcdefabcdef",
			commitSha: NEW_COMMIT,
		});
		expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /git/blobs",
			"POST /git/blobs",
			`GET /git/commits/${BASE_COMMIT}`,
			"POST /git/trees",
			"POST /git/commits",
			"POST /git/refs",
			"POST /pulls",
		]);
		expect(gh.maxInFlight()).toBe(1);
		const tree = gh.calls[3]?.body;
		// The base commit's tree, never the commit itself.
		expect(tree?.base_tree).toBe(BASE_TREE);
		expect(tree?.base_tree).not.toBe(BASE_COMMIT);
		expect(tree?.tree).toEqual([
			{
				path: "src/a.ts",
				mode: "100644",
				type: "blob",
				sha: gitBlobSha(bytes("a\n")),
			},
			{
				path: "bin/run",
				mode: "100755",
				type: "blob",
				sha: gitBlobSha(bytes("#!/bin/sh\n")),
			},
			{ path: "src/old.ts", mode: "100644", type: "blob", sha: null },
		]);
		expect(gh.calls[4]?.body).toMatchObject({
			tree: NEW_TREE,
			parents: [BASE_COMMIT],
		});
		// The long form, through createRef; nothing ever PATCHes a ref.
		expect(gh.calls[5]?.body).toEqual({
			ref: "refs/heads/avel/12345678-s1-abcdefabcdef",
			sha: NEW_COMMIT,
		});
		expect(gh.calls.some((c) => c.method === "PATCH")).toBe(false);
		expect(gh.calls[6]?.body).toMatchObject({
			head: "avel/12345678-s1-abcdefabcdef",
			base: "main",
			title: "AVEL: booking sprint 1",
		});
	});

	it("refuses a blob GitHub stores under another sha, before any tree", async () => {
		const gh = fakeGitHub({}, { wrongBlobSha: true });
		await expect(
			writer(gh.fetch).openPullRequest(request()),
		).rejects.toMatchObject({
			code: "GITHUB_REJECTED",
		});
		expect(gh.calls.map((c) => c.path)).toEqual(["/git/blobs"]);
	});

	it("refuses bytes that are not their own blobSha, before writing anything", async () => {
		const gh = fakeGitHub();
		const bad = { ...file("src/a.ts", "a\n"), blobSha: "1".repeat(40) };
		// AVEL's own render disagreeing with itself, never GitHub's silence.
		await expect(
			writer(gh.fetch).openPullRequest(request({ files: [bad] })),
		).rejects.toMatchObject({
			code: "DETERMINISM_VIOLATION",
			message: expect.stringMatching(/src\/a\.ts/),
		});
		expect(gh.calls).toEqual([]);
	});

	it("names GitHub's rate limit as one, not as a credential that cannot write", async () => {
		const limited = fakeGitHub(
			{ "POST /git/blobs": 403 },
			{ headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
		);
		await expect(
			writer(limited.fetch).openPullRequest(request()),
		).rejects.toMatchObject({
			code: "EXTERNAL_GITHUB",
			message: expect.stringMatching(/rate limit/),
		});
	});

	it("answers GITHUB_REJECTED for a status GitHub refused with, naming the step, and EXTERNAL_GITHUB for no answer", async () => {
		const exists = fakeGitHub({ "POST /git/refs": 422 });
		await expect(
			writer(exists.fetch).openPullRequest(request()),
		).rejects.toMatchObject({
			code: "GITHUB_REJECTED",
			message: expect.stringMatching(
				/creating the branch on acme\/app.*already exist/,
			),
		});
		expect(exists.calls.some((c) => c.path === "/pulls")).toBe(false);

		const denied = fakeGitHub({ "POST /git/blobs": 403 });
		await expect(
			writer(denied.fetch).openPullRequest(request()),
		).rejects.toMatchObject({
			code: "GITHUB_REJECTED",
			message: expect.stringMatching(/cannot write/),
		});

		const down = fakeGitHub({ "POST /pulls": 503 });
		await expect(
			writer(down.fetch).openPullRequest(request()),
		).rejects.toMatchObject({
			code: "EXTERNAL_GITHUB",
		});
	});
});

describe("githubRepoWriter.findPullRequest", () => {
	const find = (pulls: unknown[]) =>
		writer(fakeGitHub({}, { pulls }).fetch).findPullRequest({
			owner: "acme",
			repo: "app",
			credentialRef: "ACME_TOKEN",
			head: "avel/x",
		});
	const pr = (state: string, merged_at: string | null) => ({
		number: 7,
		html_url: "https://github.com/acme/app/pull/7",
		state,
		merged_at,
		head: { sha: NEW_COMMIT },
	});

	it("reads the PR on the branch as open, merged or closed, and null when there is none", async () => {
		expect((await find([pr("open", null)]))?.state).toBe("open");
		expect((await find([pr("closed", "2026-10-24T00:00:00Z")]))?.state).toBe(
			"merged",
		);
		expect((await find([pr("closed", null)]))?.state).toBe("closed");
		expect(await find([])).toBeNull();
	});

	it("asks for the branch in its own repository, in every state", async () => {
		const gh = fakeGitHub({}, { pulls: [] });
		await writer(gh.fetch).findPullRequest({
			owner: "acme",
			repo: "app",
			credentialRef: "ACME_TOKEN",
			head: "avel/x",
		});
		const q = new URLSearchParams(gh.calls[0]?.path.split("?")[1]);
		expect(q.get("head")).toBe("acme:avel/x");
		expect(q.get("state")).toBe("all");
	});
});
