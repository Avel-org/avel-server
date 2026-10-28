import { describe, expect, it } from "vitest";
import {
	TEMPLATE_COVER_MAX_BYTES,
	templateManifest,
	templateRef,
	templateVersion,
} from "../../src/contract";
import {
	fixtureTemplateSource,
	githubTemplateSource,
	imageType,
	MANIFEST_PATH,
	parseManifest,
	unreadableTemplates,
} from "../../src/gateways/template-source";
import {
	DEV_BOOKING_SHA,
	DEV_TEMPLATE_READS,
	devTemplateFiles,
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

	it("reads a cover, and refuses one outside the repository or not an image", () => {
		const withCover = (cover: unknown) =>
			parseManifest(JSON.stringify({ ...MANIFEST, cover }));
		const alt = "Slots";
		expect(withCover({ path: ".avel/cover.png", alt })).toEqual({
			...MANIFEST,
			cover: { path: ".avel/cover.png", alt },
		});
		expect(withCover({ path: "docs/shot.JPEG", alt })).not.toBeNull();
		expect(withCover({ path: "a/b.webp", alt })).not.toBeNull();
		for (const path of [
			"/etc/cover.png",
			"../cover.png",
			"a/../../cover.png",
			"cover.svg",
			"cover.png?raw=1",
			"",
		])
			expect(withCover({ path, alt }), path).toBeNull();
		expect(withCover({ path: "c.png", alt: " " })).toBeNull();
		expect(withCover({ path: "c.png", alt, size: 1 })).toBeNull();
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

describe("imageType", () => {
	const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0]);
	it("names PNG, JPEG and WebP by signature", () => {
		expect(
			imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
		).toBe("image/png");
		expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
		const riff = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4];
		expect(imageType(bytes(...riff, 0x57, 0x45, 0x42, 0x50))).toBe(
			"image/webp",
		);
	});

	it("refuses anything else, whatever it is named", () => {
		const text = (t: string) => new Uint8Array(Buffer.from(t, "utf8"));
		expect(
			imageType(text("<svg xmlns='http://www.w3.org/2000/svg'/>")),
		).toBeNull();
		expect(imageType(text("<html><script>x</script></html>"))).toBeNull();
		expect(
			imageType(
				bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45),
			),
		).toBeNull();
		expect(imageType(new Uint8Array())).toBeNull();
	});
});

describe("githubTemplateSource file", () => {
	const fileFetch = (body: Record<string, unknown>, status = 200) => {
		const calls: string[] = [];
		const fetch = (async (input: string | URL | Request) => {
			calls.push(String(input instanceof Request ? input.url : input));
			return Response.json(body, { status });
		}) as typeof globalThis.fetch;
		return { fetch, calls };
	};

	it("reads a file's bytes at the commit it is given", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const gh = fileFetch({
			type: "file",
			encoding: "base64",
			content: png.toString("base64"),
		});
		const got = await source(gh.fetch).file(
			"template-booking",
			SHA,
			".avel/cover.png",
		);
		expect(got && Buffer.from(got).equals(png)).toBe(true);
		const url = new URL(gh.calls[0] ?? "");
		expect(url.pathname).toBe(
			"/repos/avel-org/template-booking/contents/.avel%2Fcover.png",
		);
		expect(url.searchParams.get("ref")).toBe(SHA);
	});

	it("answers null over 1 MB, where GitHub sends no content, and for a missing file", async () => {
		const big = fileFetch({ type: "file", encoding: "none", content: "" });
		expect(
			await source(big.fetch).file("template-booking", SHA, "c.png"),
		).toBeNull();
		const errors: string[] = [];
		const gone = fileFetch({ message: "Not Found" }, 404);
		expect(
			await source(gone.fetch, errors).file("template-booking", SHA, "c.png"),
		).toBeNull();
		expect(errors).toEqual(["template-booking"]);
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

	it("reads the dev template-booking at the fixture's head", () => {
		expect(DEV_TEMPLATE_READS["template-booking"]?.headSha).toBe(
			DEV_BOOKING_SHA,
		);
	});

	it("gives the dev template-booking a cover that is a PNG under the cap", async () => {
		const read = DEV_TEMPLATE_READS["template-booking"];
		const path = read?.manifest.cover?.path ?? "";
		const bytes = devTemplateFiles()[`template-booking/${path}`];
		if (!bytes) throw new Error("no dev cover");
		expect(imageType(bytes)).toBe("image/png");
		expect(bytes.byteLength).toBeLessThanOrEqual(TEMPLATE_COVER_MAX_BYTES);
		const fixture = fixtureTemplateSource(
			TEMPLATE_REPOS,
			DEV_TEMPLATE_READS,
			devTemplateFiles(),
		);
		expect(
			await fixture.file("template-booking", DEV_BOOKING_SHA, path),
		).toEqual(bytes);
		expect(await fixture.file("template-booking", SHA, path)).toBeNull();
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
