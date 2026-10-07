import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
	githubRepoSource,
	type SnapshotRequest,
} from "../../src/gateways/repo-source";
import { snapshotFromDirectory } from "../../src/lib/repo-read/local";
import {
	LIMITS,
	MAX_BYTES,
	MAX_ENTRIES,
	MAX_TEXT_BYTES,
} from "../../src/lib/repo-read/snapshot";
import { snapshotFromTarball } from "../../src/lib/repo-read/tar";
import { ApiError } from "../../src/middleware/errors";

const SHA = "a".repeat(40);
const ROOT = `meridian-co-app-${SHA.slice(0, 7)}`;

type TarFile = { path: string; body?: Uint8Array | string; type?: string };

function header(name: string, size: number, type: string): Uint8Array {
	const h = new Uint8Array(512);
	const put = (s: string, at: number) => h.set(new TextEncoder().encode(s), at);
	put(name.slice(0, 100), 0);
	put("0000644\0", 100);
	put("0000000\0", 108);
	put("0000000\0", 116);
	put(`${size.toString(8).padStart(11, "0")}\0`, 124);
	put("00000000000\0", 136);
	put("        ", 148);
	put(type, 156);
	put("ustar\0", 257);
	put("00", 263);
	const sum = h.reduce((n, b) => n + b, 0);
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return h;
}

function pax(key: string, value: string): Uint8Array {
	const record = (n: number) => `${n} ${key}=${value}\n`;
	let n = record(0).length;
	while (record(n).length !== n) n = record(n).length;
	return new TextEncoder().encode(record(n));
}

/** A gzipped ustar archive laid out the way GitHub's tarball is. */
function tarball(files: TarFile[]): Uint8Array {
	const parts: Uint8Array[] = [];
	const push = (name: string, body: Uint8Array, type: string) => {
		parts.push(header(name, body.length, type), body);
		const pad = (512 - (body.length % 512)) % 512;
		parts.push(new Uint8Array(pad));
	};
	push("pax_global_header", pax("comment", SHA), "g");
	push(`${ROOT}/`, new Uint8Array(0), "5");
	for (const f of files) {
		const body =
			typeof f.body === "string"
				? new TextEncoder().encode(f.body)
				: (f.body ?? new Uint8Array(0));
		const full = `${ROOT}/${f.path}`;
		if (full.length > 100) push("PaxHeader", pax("path", full), "x");
		push(full, body, f.type ?? "0");
	}
	parts.push(new Uint8Array(1024));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return gzipSync(out);
}

const LONG = `src/${"deeply/".repeat(16)}nested.ts`;
const FILES: TarFile[] = [
	{ path: "package.json", body: '{ "name": "app" }\n' },
	{ path: "src/b.ts", body: "export const b = 1;\n" },
	{ path: "src/a.ts", body: "export const a = 1;\n" },
	{ path: LONG, body: "export {};\n" },
	{ path: "assets/logo.png", body: new Uint8Array([137, 80, 78, 71, 0, 1]) },
	{ path: "src/big.ts", body: "x".repeat(MAX_TEXT_BYTES + 1) },
	{ path: "node_modules/left-pad/index.js", body: "module.exports = 1;\n" },
	{ path: "src/link.ts", type: "2" },
];

describe("the size limits", () => {
	it("are named and pinned", () => {
		expect(MAX_ENTRIES).toBe(20_000);
		expect(MAX_BYTES).toBe(50 * 1024 * 1024);
		expect(MAX_TEXT_BYTES).toBe(64 * 1024);
		expect(LIMITS).toEqual({ entries: MAX_ENTRIES, bytes: MAX_BYTES });
	});
});

describe("snapshotFromTarball", () => {
	it("strips GitHub's top directory, skips dependencies and links, and sorts by path", () => {
		const s = snapshotFromTarball(tarball(FILES), SHA);
		expect(s.commitSha).toBe(SHA);
		expect(s.entries.map((e) => e.path)).toEqual(
			[
				"assets/logo.png",
				"package.json",
				"src/a.ts",
				"src/big.ts",
				LONG,
				"src/b.ts",
			].sort(),
		);
	});

	it("keeps text for small text files only", () => {
		const byPath = new Map(
			snapshotFromTarball(tarball(FILES), SHA).entries.map((e) => [e.path, e]),
		);
		expect(byPath.get("src/a.ts")).toEqual({
			path: "src/a.ts",
			size: 20,
			text: "export const a = 1;\n",
		});
		expect(byPath.get(LONG)?.text).toBe("export {};\n");
		expect(byPath.get("assets/logo.png")).toEqual({
			path: "assets/logo.png",
			size: 6,
		});
		expect(byPath.get("src/big.ts")).toEqual({
			path: "src/big.ts",
			size: MAX_TEXT_BYTES + 1,
		});
	});

	it("refuses more files than the limit with TREE_TOO_LARGE", () => {
		const read = () =>
			snapshotFromTarball(tarball(FILES), SHA, {
				entries: 5,
				bytes: MAX_BYTES,
			});
		expect(read).toThrow(ApiError);
		expect(read).toThrow(/more than 5 files/);
		expect(() =>
			snapshotFromTarball(tarball(FILES), SHA, {
				entries: 6,
				bytes: MAX_BYTES,
			}),
		).not.toThrow();
	});

	it("refuses more bytes than the limit with TREE_TOO_LARGE", () => {
		// The bytes the snapshot counts: every kept file, not node_modules or links.
		const total = FILES.filter(
			(f) => f.type !== "2" && !f.path.startsWith("node_modules/"),
		).reduce(
			(n, f) =>
				n +
				(typeof f.body === "string"
					? new TextEncoder().encode(f.body).length
					: (f.body?.length ?? 0)),
			0,
		);
		expect(() =>
			snapshotFromTarball(tarball(FILES), SHA, {
				entries: 100,
				bytes: total - 1,
			}),
		).toThrow(/more than \d+ bytes/);
		expect(() =>
			snapshotFromTarball(tarball(FILES), SHA, { entries: 100, bytes: total }),
		).not.toThrow();
	});

	it("refuses an archive that expands past the limit before it is parsed", () => {
		const bomb = tarball([
			{ path: "zeros.bin", body: new Uint8Array(4_000_000) },
		]);
		expect(bomb.length).toBeLessThan(100_000);
		try {
			snapshotFromTarball(bomb, SHA, { entries: 10, bytes: 1_000 });
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ApiError);
			expect((e as ApiError).code).toBe("TREE_TOO_LARGE");
			expect((e as ApiError).message).toContain("expands too far");
		}
	});
});

describe("snapshotFromDirectory", () => {
	const dir = mkdtempSync(join(tmpdir(), "avel-repo-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("reads the same snapshot from disk as from the tarball of the same files", () => {
		for (const f of FILES) {
			if (f.type === "2") continue;
			const full = join(dir, f.path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, f.body ?? "");
		}
		expect(snapshotFromDirectory(dir, SHA)).toEqual(
			snapshotFromTarball(tarball(FILES), SHA),
		);
	});
});

describe("githubRepoSource", () => {
	const TOKEN = "ghp_secretTokenValue123";
	const req: SnapshotRequest = {
		owner: "meridian-co",
		repo: "app",
		credentialRef: "MERIDIAN_GITHUB_TOKEN",
	};
	const env = (name: string) =>
		name === "MERIDIAN_GITHUB_TOKEN"
			? TOKEN
			: name === "EMPTY"
				? ""
				: undefined;

	/** A fetch that answers GitHub's two calls, recording what was asked. */
	function github(commitStatus = 200) {
		const calls: Array<{ url: string; auth: string | null }> = [];
		const fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			const headers = new Headers(init?.headers);
			calls.push({ url, auth: headers.get("authorization") });
			if (url.includes("/commits/")) {
				return commitStatus === 200
					? Response.json({ sha: SHA })
					: Response.json(
							{ message: `GitHub says ${TOKEN}` },
							{ status: commitStatus },
						);
			}
			if (url.includes("/tarball/")) {
				return new Response(tarball(FILES), {
					headers: { "content-type": "application/x-gzip" },
				});
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof globalThis.fetch;
		return { fetch, calls };
	}

	it("resolves a credential by name, and treats an unset or empty one as missing", () => {
		const source = githubRepoSource({ env });
		expect(source.hasCredential("MERIDIAN_GITHUB_TOKEN")).toBe(true);
		expect(source.hasCredential("EMPTY")).toBe(false);
		expect(source.hasCredential("NOT_SET")).toBe(false);
	});

	it("pins the commit first, then reads the tarball at exactly that sha", async () => {
		const gh = github();
		const s = await githubRepoSource({ env, fetch: gh.fetch }).snapshot(req);
		expect(s.commitSha).toBe(SHA);
		expect(s.entries.map((e) => e.path)).toContain("src/a.ts");
		expect(gh.calls.map((c) => new URL(c.url).pathname)).toEqual([
			"/repos/meridian-co/app/commits/HEAD",
			`/repos/meridian-co/app/tarball/${SHA}`,
		]);
		expect(gh.calls.every((c) => c.auth === `token ${TOKEN}`)).toBe(true);
	});

	it("reads a given ref instead of the default branch", async () => {
		const gh = github();
		await githubRepoSource({ env, fetch: gh.fetch }).snapshot({
			...req,
			ref: "release",
		});
		expect(new URL(gh.calls[0]?.url ?? "").pathname).toBe(
			"/repos/meridian-co/app/commits/release",
		);
	});

	it("maps each GitHub status to its repository code, never echoing the token", async () => {
		for (const [status, code] of [
			[401, "REPO_NO_ACCESS"],
			[403, "REPO_NO_ACCESS"],
			[404, "REPO_NOT_FOUND"],
			[409, "EMPTY_REPOSITORY"],
			[422, "BRANCH_NOT_FOUND"],
			[500, "EXTERNAL_GITHUB"],
		] as const) {
			const gh = github(status);
			const failure = await githubRepoSource({ env, fetch: gh.fetch })
				.snapshot(req)
				.catch((e: unknown) => e);
			expect(failure, String(status)).toBeInstanceOf(ApiError);
			expect((failure as ApiError).code, String(status)).toBe(code);
			expect((failure as ApiError).message).not.toContain(TOKEN);
		}
	});

	it("answers EXTERNAL_GITHUB when GitHub cannot be reached", async () => {
		const down = (async () => {
			throw new TypeError("fetch failed");
		}) as typeof globalThis.fetch;
		const failure = await githubRepoSource({ env, fetch: down })
			.snapshot(req)
			.catch((e: unknown) => e);
		expect((failure as ApiError).code).toBe("EXTERNAL_GITHUB");
	});

	it("answers EMPTY_REPOSITORY when the tarball holds no files", async () => {
		const empty = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			return url.includes("/commits/")
				? Response.json({ sha: SHA })
				: new Response(tarball([]), {
						headers: { "content-type": "application/x-gzip" },
					});
		}) as typeof globalThis.fetch;
		const failure = await githubRepoSource({ env, fetch: empty })
			.snapshot(req)
			.catch((e: unknown) => e);
		expect((failure as ApiError).code).toBe("EMPTY_REPOSITORY");
	});
});
