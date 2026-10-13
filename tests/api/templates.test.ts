import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	successEnvelope,
	TEMPLATE_COVER_MAX_BYTES,
	templateSchema,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { mission, playbook, rosterPreset } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { fixtureTemplateSource } from "../../src/gateways/template-source";
import { clock, withApi } from "./support";

const list = successEnvelope(templateSchema.array());
const one = successEnvelope(templateSchema);
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * Slugs under a fresh tag, so parallel test files never share a playbook
 * key. withApi picks its ns inside, after the source is built, so the tag is
 * the test's own.
 */
const slugsFor = (tag: string) => ({
	built: `template-built-${tag}`,
	bare: `template-bare-${tag}`,
	broken: `template-broken-${tag}`,
});

const newTag = () => randomUUID().slice(0, 8);

function source(tag: string) {
	const s = slugsFor(tag);
	return fixtureTemplateSource([s.built, s.bare, s.broken], {
		[s.built]: {
			manifest: {
				name: "Built",
				scope: "full-stack",
				startingState: "greenfield",
			},
			headSha: SHA,
		},
		[s.bare]: {
			manifest: { name: "Bare", scope: "audit", startingState: "brownfield" },
			headSha: SHA,
		},
	});
}

/** A playbook and three missions for the built template: two live, one deleted. */
async function seed(tx: Tx, ns: string, tag: string) {
	const s = slugsFor(tag);
	let n = 0xc00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const presetId = id();
	await tx.insert(rosterPreset).values({
		id: presetId,
		name: `Preset ${ns}`,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamp(clock),
	});
	await tx.insert(playbook).values({
		id: id(),
		missionType: s.built,
		name: "Built",
		wavesApplicable: ["A"],
		gates: [],
		deliverable: "pr",
		requiredFields: [],
		defaultPresetId: presetId,
		version: 1,
		...stamp(clock),
	});
	for (const deletedAt of [null, null, clock.now()]) {
		await tx.insert(mission).values({
			id: id(),
			origin: "internal",
			engagementId: null,
			type: s.built,
			brief: {},
			sprintN: 1,
			status: "draft",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			templateRef: s.built,
			templateVersion: SHA,
			deletedAt,
			...stamp(clock),
		});
	}
	return { ...s, presetId };
}

describe.skipIf(!process.env.DATABASE_URL)("/api/templates", () => {
	afterAll(closeDb);

	it("lists every allowlisted template in order, an unreadable one included", async () => {
		const tag = newTag();
		await withApi(
			async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = await seed(tx, ns, tag);
				const res = await call("/api/templates");
				expect(res.status).toBe(200);
				expect(list.parse(await res.json()).data).toEqual([
					{
						slug: s.built,
						readable: true,
						name: "Built",
						scope: "full-stack",
						startingState: "greenfield",
						latestSha: SHA,
						cover: null,
						defaultPresetId: s.presetId,
						missionCount: 2,
					},
					{
						slug: s.bare,
						readable: true,
						name: "Bare",
						scope: "audit",
						startingState: "brownfield",
						latestSha: SHA,
						cover: null,
						defaultPresetId: null,
						missionCount: 0,
					},
					{
						slug: s.broken,
						readable: false,
						name: null,
						scope: null,
						startingState: null,
						latestSha: null,
						cover: null,
						defaultPresetId: null,
						missionCount: 0,
					},
				]);
			},
			{ templates: source(tag) },
		);
	});

	it("reads one by slug, and answers 404 outside the allowlist", async () => {
		const tag = newTag();
		await withApi(
			async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = await seed(tx, ns, tag);
				const res = await call(`/api/templates/${s.built}`);
				expect(res.status).toBe(200);
				expect(one.parse(await res.json()).data).toMatchObject({
					slug: s.built,
					missionCount: 2,
				});
				expect((await call("/api/templates/template-elsewhere")).status).toBe(
					404,
				);
			},
			{ templates: source(tag) },
		);
	});

	describe("covers", () => {
		const PNG = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
		]);
		const alt = "Slots";

		/**
		 * Five templates under a fresh tag: one with a PNG cover, one with no
		 * cover, and three whose cover is text, one byte over the cap, or missing.
		 * A sixth, outside, has a readable cover but is not in the allowlist.
		 */
		const covered = () => {
			const tag = newTag();
			const slug = (name: string) => `template-${name}-${tag}`;
			const s = {
				png: slug("png"),
				plain: slug("plain"),
				text: slug("text"),
				big: slug("big"),
				gone: slug("gone"),
			};
			const outside = slug("outside");
			const withCover = {
				manifest: {
					name: "Covered",
					scope: "full-stack" as const,
					startingState: "greenfield" as const,
					cover: { path: "c.png", alt },
				},
				headSha: SHA,
			};
			const big = new Uint8Array(TEMPLATE_COVER_MAX_BYTES + 1);
			big.set(PNG);
			const source = fixtureTemplateSource(
				Object.values(s),
				{
					[s.png]: withCover,
					[s.plain]: {
						manifest: {
							name: "Plain",
							scope: "audit",
							startingState: "brownfield",
						},
						headSha: SHA,
					},
					[s.text]: withCover,
					[s.big]: withCover,
					[s.gone]: withCover,
					[outside]: withCover,
				},
				{
					[`${s.png}/c.png`]: PNG,
					[`${s.text}/c.png`]: new Uint8Array(Buffer.from("<svg/>")),
					[`${s.big}/c.png`]: big,
					[`${outside}/c.png`]: PNG,
				},
			);
			return { s, source, outside };
		};

		it("lists a cover as a same-origin url pinned to the head", async () => {
			const { s, source } = covered();
			await withApi(
				async ({ signIn, call }) => {
					await signIn();
					const res = await call("/api/templates");
					const data = list.parse(await res.json()).data;
					const at = (slug: string) => ({
						url: `/api/templates/${slug}/cover?sha=${SHA}`,
						alt,
					});
					expect(data.map((t) => [t.slug, t.cover])).toEqual([
						[s.png, at(s.png)],
						[s.plain, null],
						[s.text, at(s.text)],
						[s.big, at(s.big)],
						[s.gone, at(s.gone)],
					]);
				},
				{ templates: source },
			);
		});

		it("serves the image, cached as immutable only at the head sha", async () => {
			const { s, source } = covered();
			await withApi(
				async ({ signIn, call }) => {
					await signIn();
					const res = await call(`/api/templates/${s.png}/cover?sha=${SHA}`);
					expect(res.status).toBe(200);
					expect(res.headers.get("content-type")).toBe("image/png");
					expect(res.headers.get("x-content-type-options")).toBe("nosniff");
					expect(res.headers.get("cache-control")).toBe(
						"private, max-age=31536000, immutable",
					);
					expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
					for (const query of ["", `?sha=${"f".repeat(40)}`]) {
						const loose = await call(`/api/templates/${s.png}/cover${query}`);
						expect(loose.status, query).toBe(200);
						expect(loose.headers.get("cache-control"), query).toBe(
							"private, no-cache",
						);
					}
				},
				{ templates: source },
			);
		});

		it("answers 404 in the envelope for no cover, a non-image, oversized or missing file, and a slug outside the allowlist", async () => {
			const { s, source, outside } = covered();
			await withApi(
				async ({ signIn, call }) => {
					await signIn();
					for (const slug of [s.plain, s.text, s.big, s.gone, outside]) {
						const res = await call(`/api/templates/${slug}/cover`);
						expect(res.status, slug).toBe(404);
						const body = errorEnvelope.parse(await res.json());
						expect(body.error.code, slug).toBe("NOT_FOUND");
					}
				},
				{ templates: source },
			);
		});

		it("needs a session", async () => {
			const { s, source } = covered();
			await withApi(
				async ({ call }) => {
					const res = await call(`/api/templates/${s.png}/cover`);
					expect(res.status).toBe(401);
				},
				{ templates: source },
			);
		});
	});

	it("needs a session", async () => {
		const tag = newTag();
		await withApi(
			async ({ call }) => {
				expect((await call("/api/templates")).status).toBe(401);
			},
			{ templates: source(tag) },
		);
	});
});
