import { afterAll, describe, expect, it } from "vitest";
import {
	agentTemplateSchema,
	errorEnvelope,
	pageEnvelope,
	skillListItem,
	skillSchema,
	skillSourceSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	agentTemplate,
	client,
	engagement,
	skill,
	skillSource,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

const templateList = pageEnvelope(agentTemplateSchema);
const templateOne = successEnvelope(agentTemplateSchema);
const skillList = pageEnvelope(skillListItem);
const skillOne = successEnvelope(skillSchema);
const sourceList = pageEnvelope(skillSourceSchema);
const sourceOne = successEnvelope(skillSourceSchema);

/** `h` hours after the test clock, so list order is fixed by created_at. */
function at(h: number) {
	return new Date(clock.now().getTime() + h * 3_600_000);
}

/**
 * Catalog rows under this call's namespace. Slugs and names carry `ns`, so
 * `q=ns` isolates them from any other test's rows, and parallel files never
 * contend on the live-slug unique indexes.
 */
async function seedCatalog(tx: Tx, ns: string) {
	let n = 0x900;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const clientId = id();
	await tx.insert(client).values({
		id: clientId,
		name: `Client ${ns}`,
		status: "active",
		...stamp(clock),
	});
	const engagementId = id();
	await tx.insert(engagement).values({
		id: engagementId,
		clientId,
		name: `Engagement ${ns}`,
		status: "active",
		startedAt: clock.now(),
		...stamp(clock),
	});

	const template = async (
		h: number,
		slug: string,
		values: Pick<
			typeof agentTemplate.$inferInsert,
			"kind" | "roles" | "waveDefaults"
		> &
			Partial<typeof agentTemplate.$inferInsert>,
	) => {
		const row = {
			id: id(),
			slug: `${ns}-${slug}`,
			name: `${slug} ${ns}`,
			engagementId: null,
			identityMd: `# ${slug}\n`,
			depthMd: "",
			writablePaths: ["src/**"],
			version: 1,
			createdAt: at(h),
			updatedAt: at(h),
			...values,
		};
		await tx.insert(agentTemplate).values(row);
		return row;
	};
	const atlas = await template(1, "atlas", {
		kind: "horizontal",
		roles: ["schema", "contract"],
		waveDefaults: ["A"],
	});
	const nemi = await template(2, "nemi", {
		kind: "feature",
		roles: ["domain"],
		waveDefaults: ["B"],
		engagementId,
		description: "Builds the domain.",
	});
	const gone = await template(3, "gone", {
		kind: "horizontal",
		roles: ["backend-tests"],
		waveDefaults: ["C"],
		deletedAt: at(4),
	});

	const source = async (
		h: number,
		name: string,
		kind: "internal" | "vendor" | "community",
		deletedAt: Date | null = null,
	) => {
		const row = {
			id: id(),
			name: `${name} ${ns}`,
			kind,
			url: kind === "vendor" ? "https://example.com/skills" : null,
			license: kind === "vendor" ? "MIT" : null,
			deletedAt,
			createdAt: at(h),
			updatedAt: at(h),
		};
		await tx.insert(skillSource).values(row);
		return row;
	};
	const internal = await source(1, "Internal", "internal");
	const vendor = await source(2, "Vendor", "vendor");
	const retiredSource = await source(3, "Retired", "community", at(4));

	const base = {
		description: "When to use it.",
		contentMd: "# Full text\n",
		avelEnhancementMd: null,
		contentSha256: "a".repeat(64),
		reviewedBy: null,
		version: 1,
	};
	const keyset = {
		...base,
		id: id(),
		slug: `${ns}-keyset`,
		name: `Keyset ${ns}`,
		layer: "stack" as const,
		type: "knowledge" as const,
		grants: null,
		ioShape: null,
		recommendedFor: ["domain" as const],
		sourceId: internal.id,
		status: "approved" as const,
		reviewedAt: at(1),
		createdAt: at(1),
		updatedAt: at(1),
	};
	const search = {
		...base,
		id: id(),
		slug: `${ns}-search`,
		name: `Search ${ns}`,
		avelEnhancementMd: "## AVEL notes\n",
		layer: "domain" as const,
		type: "capability" as const,
		grants: ["read:source"],
		ioShape: { reads: "large" as const, returns: "small" as const },
		recommendedFor: ["schema" as const],
		sourceId: internal.id,
		status: "draft" as const,
		reviewedAt: null,
		createdAt: at(2),
		updatedAt: at(2),
	};
	const deletedSkill = {
		...keyset,
		id: id(),
		slug: `${ns}-old`,
		name: `Old ${ns}`,
		deletedAt: at(4),
		createdAt: at(3),
		updatedAt: at(4),
	};
	await tx.insert(skill).values([keyset, search, deletedSkill]);

	return {
		engagementId,
		atlas,
		nemi,
		gone,
		internal,
		vendor,
		retiredSource,
		keyset,
		search,
		deletedSkill,
	};
}

describe.skipIf(!process.env.DATABASE_URL)("/api/agent-templates", () => {
	afterAll(closeDb);

	it("lists live templates newest first, with meta.total", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { atlas, nemi } = await seedCatalog(tx, ns);
			const res = await call(`/api/agent-templates?q=${ns}`);
			expect(res.status).toBe(200);
			const body = templateList.parse(await res.json());
			expect(body.data.map((t) => t.slug)).toEqual([nemi.slug, atlas.slug]);
			expect(body.meta).toEqual({ nextCursor: null, total: 2 });
			expect(body.data[0]).toEqual({
				id: nemi.id,
				slug: nemi.slug,
				name: nemi.name,
				kind: "feature",
				roles: ["domain"],
				engagementId: nemi.engagementId,
				waveDefaults: ["B"],
				description: "Builds the domain.",
				identityMd: "# nemi\n",
				depthMd: "",
				writablePaths: ["src/**"],
				version: 1,
				createdAt: at(2).toISOString(),
				updatedAt: at(2).toISOString(),
			});
			expect(body.data[1]?.description).toBeNull();
		});
	});

	it("filters by kind, role, wave and engagement", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { atlas, nemi, engagementId } = await seedCatalog(tx, ns);
			const slugs = async (filter: string) =>
				templateList
					.parse(
						await (await call(`/api/agent-templates?q=${ns}&${filter}`)).json(),
					)
					.data.map((t) => t.slug);
			expect(await slugs("kind=feature")).toEqual([nemi.slug]);
			expect(await slugs("role[0]=schema&role[1]=domain")).toEqual([
				nemi.slug,
				atlas.slug,
			]);
			expect(await slugs("role=contract")).toEqual([atlas.slug]);
			// Only the deleted template holds backend-tests.
			expect(await slugs("role=backend-tests")).toEqual([]);
			expect(await slugs("wave=B&wave=A")).toEqual([nemi.slug, atlas.slug]);
			expect(await slugs(`engagementId=${engagementId}`)).toEqual([nemi.slug]);
		});
	});

	it("pages by cursor, reaching each template once", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { atlas, nemi } = await seedCatalog(tx, ns);
			const first = templateList.parse(
				await (await call(`/api/agent-templates?q=${ns}&limit=1`)).json(),
			);
			expect(first.data.map((t) => t.slug)).toEqual([nemi.slug]);
			expect(first.meta.total).toBe(2);
			const cursor = first.meta.nextCursor;
			expect(cursor).not.toBeNull();
			const second = templateList.parse(
				await (
					await call(`/api/agent-templates?q=${ns}&limit=1&cursor=${cursor}`)
				).json(),
			);
			expect(second.data.map((t) => t.slug)).toEqual([atlas.slug]);
			expect(second.meta.nextCursor).toBeNull();
		});
	});

	it("gets a live template by id and by slug, and 404s a deleted one", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { atlas, gone } = await seedCatalog(tx, ns);

			const byId = await call(`/api/agent-templates/${atlas.id}`);
			expect(byId.status).toBe(200);
			expect(templateOne.parse(await byId.json()).data.slug).toBe(atlas.slug);

			const bySlug = await call(`/api/agent-templates/by-slug/${atlas.slug}`);
			expect(bySlug.status).toBe(200);
			expect(templateOne.parse(await bySlug.json()).data.id).toBe(atlas.id);

			for (const path of [
				`/api/agent-templates/${gone.id}`,
				`/api/agent-templates/by-slug/${gone.slug}`,
				`/api/agent-templates/by-slug/${ns}-nobody`,
			]) {
				const res = await call(path);
				expect(res.status).toBe(404);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"NOT_FOUND",
				);
			}
		});
	});

	it("refuses an unknown filter value and a malformed id with 400", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			for (const path of [
				"/api/agent-templates?role=tester",
				"/api/agent-templates?wave=F",
				"/api/agent-templates/not-a-uuid",
			]) {
				const res = await call(path);
				expect(res.status).toBe(400);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"VALIDATION_FAILED",
				);
			}
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/skills", () => {
	afterAll(closeDb);

	it("lists live skills without their text, with the source joined", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { keyset, search, internal } = await seedCatalog(tx, ns);
			const res = await call(`/api/skills?q=${ns}`);
			expect(res.status).toBe(200);
			// Checked on the raw body: parsing strips keys the schema lacks.
			const json = (await res.json()) as { data: object[] };
			const body = skillList.parse(json);
			expect(body.data.map((s) => s.slug)).toEqual([search.slug, keyset.slug]);
			expect(body.meta).toEqual({ nextCursor: null, total: 2 });
			expect(json.data[0]).not.toHaveProperty("contentMd");
			expect(json.data[0]).not.toHaveProperty("avelEnhancementMd");
			expect(body.data[0]).toMatchObject({
				type: "capability",
				grants: ["read:source"],
				ioShape: { reads: "large", returns: "small" },
				source: { id: internal.id, name: internal.name, kind: "internal" },
				status: "draft",
				reviewedAt: null,
			});
			expect(body.data[1]).toMatchObject({
				type: "knowledge",
				grants: null,
				ioShape: null,
				reviewedAt: at(1).toISOString(),
			});
		});
	});

	it("filters by layer, type, status, role and source", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { keyset, search, internal, vendor } = await seedCatalog(tx, ns);
			const slugs = async (filter: string) =>
				skillList
					.parse(await (await call(`/api/skills?q=${ns}&${filter}`)).json())
					.data.map((s) => s.slug);
			expect(await slugs("layer=stack")).toEqual([keyset.slug]);
			expect(await slugs("type=capability")).toEqual([search.slug]);
			expect(await slugs("status[0]=draft&status[1]=retired")).toEqual([
				search.slug,
			]);
			expect(await slugs("role=domain")).toEqual([keyset.slug]);
			expect(await slugs(`sourceId=${internal.id}`)).toEqual([
				search.slug,
				keyset.slug,
			]);
			expect(await slugs(`sourceId=${vendor.id}`)).toEqual([]);
		});
	});

	it("gets one skill with its text by id and by slug, and 404s a deleted one", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { search, deletedSkill } = await seedCatalog(tx, ns);

			const byId = await call(`/api/skills/${search.id}`);
			expect(byId.status).toBe(200);
			expect(skillOne.parse(await byId.json()).data).toMatchObject({
				slug: search.slug,
				contentMd: "# Full text\n",
				avelEnhancementMd: "## AVEL notes\n",
				type: "capability",
			});

			const bySlug = await call(`/api/skills/by-slug/${search.slug}`);
			expect(bySlug.status).toBe(200);
			expect(skillOne.parse(await bySlug.json()).data.id).toBe(search.id);

			for (const path of [
				`/api/skills/${deletedSkill.id}`,
				`/api/skills/by-slug/${deletedSkill.slug}`,
			]) {
				expect((await call(path)).status).toBe(404);
			}
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/skill-sources", () => {
	afterAll(closeDb);

	it("lists live sources with their live skill counts", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { internal, vendor } = await seedCatalog(tx, ns);
			const res = await call(`/api/skill-sources?q=${ns}`);
			expect(res.status).toBe(200);
			const body = sourceList.parse(await res.json());
			expect(body.meta).toEqual({ nextCursor: null, total: 2 });
			expect(body.data).toEqual([
				{
					id: vendor.id,
					name: vendor.name,
					kind: "vendor",
					url: "https://example.com/skills",
					license: "MIT",
					skillCount: 0,
					createdAt: at(2).toISOString(),
					updatedAt: at(2).toISOString(),
				},
				{
					id: internal.id,
					name: internal.name,
					kind: "internal",
					url: null,
					license: null,
					// Two live skills; the deleted third is not counted.
					skillCount: 2,
					createdAt: at(1).toISOString(),
					updatedAt: at(1).toISOString(),
				},
			]);
		});
	});

	it("filters by kind, and gets one source by id", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { internal, retiredSource } = await seedCatalog(tx, ns);
			const filtered = sourceList.parse(
				await (
					await call(`/api/skill-sources?q=${ns}&kind=internal&kind=community`)
				).json(),
			);
			expect(filtered.data.map((s) => s.id)).toEqual([internal.id]);

			const got = await call(`/api/skill-sources/${internal.id}`);
			expect(got.status).toBe(200);
			expect(sourceOne.parse(await got.json()).data.skillCount).toBe(2);

			expect(
				(await call(`/api/skill-sources/${retiredSource.id}`)).status,
			).toBe(404);
		});
	});
});
