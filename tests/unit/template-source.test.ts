import { describe, expect, it } from "vitest";
import {
	templateManifest,
	templateRef,
	templateVersion,
} from "../../src/contract";
import { BOOKING_TEMPLATE_SHA } from "../../src/db/seed/data";
import {
	fixtureTemplateSource,
	githubTemplateSource,
	MANIFEST_PATH,
	parseManifest,
	unreadableTemplates,
} from "../../src/gateways/template-source";
import {
	DEV_BOOKING_SHA,
	DEV_TEMPLATE_READS,
	TEMPLATE_REPOS,
} from "../../src/lib/templates";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "ghp_template_token";
const MANIFEST = {
	name: "Booking",
	scope: "full-stack",
	startingState: "greenfield",
};

/** A fetch that answers GitHub's commit and contents calls, recording them. */
function github(options: { commitStatus?: number; manifest?: string } = {}) {
	const calls: Array<{ url: string; auth: string | null }> = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
		if (url.includes("/commits/")) {
			return (options.commitStatus ?? 200) === 200
				? Response.json({ sha: SHA })
				: Response.json(
						{ message: "Not Found" },
						{ status: options.commitStatus },
					);
		}
		if (url.includes("/contents/")) {
			const text = options.manifest ?? JSON.stringify(MANIFEST);
			return Response.json({
				type: "file",
				encoding: "base64",
				content: Buffer.from(text, "utf8").toString("base64"),
			});
		}
		return new Response("unexpected", { status: 500 });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const source = (fetch: typeof globalThis.fetch, errors: string[] = []) =>
	githubTemplateSource({
		slugs: ["template-booking"],
		owner: "avel-org",
		token: TOKEN,
		fetch,
		onError: (slug) => errors.push(slug),
	});

describe("parseManifest", () => {
	it("reads a valid manifest", () => {
		expect(parseManifest(JSON.stringify(MANIFEST))).toEqual(MANIFEST);
	});

	it("refuses bad JSON, an unknown scope, and extra keys", () => {
		expect(parseManifest("{")).toBeNull();
		expect(
			parseManifest(JSON.stringify({ ...MANIFEST, scope: "booking" })),
		).toBeNull();
		expect(
			parseManifest(JSON.stringify({ ...MANIFEST, cut: "vertical" })),
		).toBeNull();
	});
});

describe("githubTemplateSource", () => {
	it("reads the head commit, then the manifest at that commit", async () => {
		const gh = github();
		expect(await source(gh.fetch).read("template-booking")).toEqual({
			manifest: MANIFEST,
			headSha: SHA,
		});
		expect(gh.calls.map((c) => new URL(c.url).pathname)).toEqual([
			"/repos/avel-org/template-booking/commits/HEAD",
			`/repos/avel-org/template-booking/contents/${MANIFEST_PATH.replace("/", "%2F")}`,
		]);
		expect(new URL(gh.calls[1]?.url ?? "").searchParams.get("ref")).toBe(SHA);
		expect(gh.calls.every((c) => c.auth === `token ${TOKEN}`)).toBe(true);
	});

	it("answers null for a missing repository, and reports it", async () => {
		const errors: string[] = [];
		const read = await source(github({ commitStatus: 404 }).fetch, errors).read(
			"template-booking",
		);
		expect(read).toBeNull();
		expect(errors).toEqual(["template-booking"]);
	});

	it("answers null for a manifest that does not parse", async () => {
		const read = await source(github({ manifest: "not json" }).fetch).read(
			"template-booking",
		);
		expect(read).toBeNull();
	});
});

describe("template configuration", () => {
	it("lists slugs a mission's templateRef can hold, once each", () => {
		for (const slug of TEMPLATE_REPOS)
			expect(templateRef.safeParse(slug).success).toBe(true);
		expect(new Set(TEMPLATE_REPOS).size).toBe(TEMPLATE_REPOS.length);
	});

	it("has a dev read for every slug, each one valid or deliberately null", () => {
		expect(Object.keys(DEV_TEMPLATE_READS).sort()).toEqual(
			[...TEMPLATE_REPOS].sort(),
		);
		for (const read of Object.values(DEV_TEMPLATE_READS)) {
			if (read === null) continue;
			expect(templateManifest.parse(read.manifest)).toEqual(read.manifest);
			expect(templateVersion.safeParse(read.headSha).success).toBe(true);
		}
		expect(DEV_TEMPLATE_READS["template-integration"]).toBeNull();
	});

	it("gives the seeded missions the fixture's template-booking head", () => {
		expect(BOOKING_TEMPLATE_SHA).toBe(DEV_BOOKING_SHA);
		expect(DEV_TEMPLATE_READS["template-booking"]?.headSha).toBe(
			DEV_BOOKING_SHA,
		);
	});

	it("serves fixtures by slug, and lists without reading when unreadable", async () => {
		const fixture = fixtureTemplateSource(["a", "b"], {
			a: { manifest: templateManifest.parse(MANIFEST), headSha: SHA },
		});
		expect(fixture.slugs).toEqual(["a", "b"]);
		expect(await fixture.read("a")).not.toBeNull();
		expect(await fixture.read("b")).toBeNull();
		const none = unreadableTemplates(["a"]);
		expect(none.slugs).toEqual(["a"]);
		expect(await none.read("a")).toBeNull();
	});
});
