import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	agentTemplateSchema,
	identityVersionSchema,
	identityVersionSummary,
	pageEnvelope,
	type Role,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	agentIdentityVersion,
	agentTemplate,
	roleSkills,
	skill,
	skillSource,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import {
	type GeneratedIdentity,
	generateIdentity,
	type IdentitySkill,
} from "../../src/lib/identity";
import { clock, withApi } from "./support";

const templateOne = successEnvelope(agentTemplateSchema);
const templatePage = pageEnvelope(agentTemplateSchema);
const versionList = successEnvelope(identityVersionSummary.array());
const versionOne = successEnvelope(identityVersionSchema);

/**
 * Quill (schema) with an approved role skill and v1 generated from today's
 * inputs, then v2 generated as if it also held contract. v1 is current.
 * Also the operator (no identity) and a deleted template with one version.
 */
async function seed(tx: Tx, ns: string) {
	let n = 0xe00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const sourceId = id();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: `Source ${ns}`,
		kind: "internal",
		...stamp(clock),
	});
	const roleSkill: IdentitySkill = {
		id: id(),
		slug: `${ns}-inspect`,
		name: "Inspect",
		description: "Read the tables first.",
		contentMd: "# Inspect\n\nRead before writing.",
		avelEnhancementMd: null,
		contentSha256: "c".repeat(64),
		status: "approved",
	};
	await tx.insert(skill).values({
		...roleSkill,
		layer: "role",
		type: "knowledge",
		recommendedFor: ["schema"],
		sourceId,
		version: 1,
		...stamp(clock),
	});
	await tx.insert(roleSkills).values({ role: "schema", skillId: roleSkill.id });

	const newTemplate = async (
		slug: string,
		roles: Role[],
		deletedAt: Date | null = null,
	) => {
		const templateId = id();
		await tx.insert(agentTemplate).values({
			id: templateId,
			slug,
			name: "Quill",
			title: "Database engineer",
			kind: "horizontal",
			roles,
			waveDefaults: ["A"],
			writablePaths: ["src/db/**"],
			version: 1,
			deletedAt,
			...stamp(clock),
		});
		return templateId;
	};
	const generated = (slug: string, roles: Role[]): GeneratedIdentity => {
		const g = generateIdentity({
			slug,
			name: "Quill",
			kind: "horizontal",
			roles,
			writablePaths: ["src/db/**"],
			roleSkills: [roleSkill],
		});
		if ("refused" in g) throw new Error(g.refused);
		return g;
	};
	const addVersion = async (
		templateId: string,
		number: number,
		g: GeneratedIdentity,
	) => {
		await tx.insert(agentIdentityVersion).values({
			id: id(),
			agentTemplateId: templateId,
			number,
			identityMd: g.identityMd,
			depthMd: g.depthMd,
			sha256: g.sha256,
			identityTokens: g.identityTokens,
			depthTokens: g.depthTokens,
			inputs: g.inputs,
			generatedBy: null,
			createdAt: new Date(clock.now().getTime() + number * 1000),
		});
	};

	const slug = `${ns}-quill`;
	const quill = await newTemplate(slug, ["schema"]);
	const v1 = generated(slug, ["schema"]);
	const v2 = generated(slug, ["schema", "contract"]);
	await addVersion(quill, 1, v1);
	await addVersion(quill, 2, v2);

	const operator = await newTemplate(`${ns}-operator`, ["foundations"]);

	const goneSlug = `${ns}-gone`;
	const gone = await newTemplate(goneSlug, ["schema"], clock.now());
	const goneV1 = generated(goneSlug, ["schema"]);
	await addVersion(gone, 1, goneV1);

	return { slug, quill, v1, v2, operator, gone, goneSlug, goneV1, roleSkill };
}

describe.skipIf(!process.env.DATABASE_URL)("identity versions", () => {
	afterAll(closeDb);

	it("puts the identity in force on the template, without its text", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(`/api/agent-templates/${s.quill}`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: object };
			expect(body.data).not.toHaveProperty("identityMd");
			expect(body.data).not.toHaveProperty("depthMd");
			// v1 matches today's inputs, so it is in force though v2 is newer.
			expect(templateOne.parse(body).data).toMatchObject({
				title: "Database engineer",
				identityVersion: 1,
				identitySha256: s.v1.sha256,
				identityStale: false,
				staleInputs: [],
			});
		});
	});

	it("reads stale and names what moved", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx
				.update(agentTemplate)
				.set({ name: "Quilla" })
				.where(eq(agentTemplate.id, s.quill));
			const res = await call(`/api/agent-templates/${s.quill}`);
			expect(templateOne.parse(await res.json()).data).toMatchObject({
				identityVersion: 2,
				identitySha256: s.v2.sha256,
				identityStale: true,
				staleInputs: ["name", "roles", "definitionsSha256"],
			});
		});
	});

	it("gives the operator no identity", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(`/api/agent-templates/${s.operator}`);
			expect(templateOne.parse(await res.json()).data).toMatchObject({
				identityVersion: null,
				identitySha256: null,
				identityStale: false,
				staleInputs: [],
			});
		});
	});

	it("carries identity state on the list and by slug", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const list = templatePage.parse(
				await (await call(`/api/agent-templates?q=${ns}`)).json(),
			).data;
			expect(
				list.map((t) => [t.slug, t.identityVersion, t.identityStale]),
			).toEqual([
				[`${ns}-operator`, null, false],
				[s.slug, 1, false],
			]);
			const bySlug = templateOne.parse(
				await (await call(`/api/agent-templates/by-slug/${s.slug}`)).json(),
			).data;
			expect(bySlug.identitySha256).toBe(s.v1.sha256);
		});
	});

	it("lists versions newest first, without text", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(
				`/api/agent-templates/${s.quill}/identity/versions`,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: object[] };
			expect(body.data[0]).not.toHaveProperty("identityMd");
			expect(
				versionList.parse(body).data.map((v) => [v.ref, v.sha256]),
			).toEqual([
				[`${s.slug}@v2`, s.v2.sha256],
				[`${s.slug}@v1`, s.v1.sha256],
			]);
		});
	});

	it("reads one version with its text and inputs", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(
				`/api/agent-templates/${s.quill}/identity/versions/1`,
			);
			expect(res.status).toBe(200);
			expect(versionOne.parse(await res.json()).data).toEqual({
				ref: `${s.slug}@v1`,
				number: 1,
				sha256: s.v1.sha256,
				identityTokens: s.v1.identityTokens,
				depthTokens: s.v1.depthTokens,
				generatedBy: null,
				createdAt: new Date(clock.now().getTime() + 1000).toISOString(),
				agentTemplateId: s.quill,
				identityMd: s.v1.identityMd,
				depthMd: s.v1.depthMd,
				inputs: s.v1.inputs,
			});
			const missing = await call(
				`/api/agent-templates/${s.quill}/identity/versions/3`,
			);
			expect(missing.status).toBe(404);
		});
	});

	it("resolves a sha or a ref to the same version", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const bySha = versionOne.parse(
				await (await call(`/api/identity-versions/${s.v2.sha256}`)).json(),
			).data;
			const byRef = versionOne.parse(
				await (await call(`/api/identity-versions/${s.slug}@v2`)).json(),
			).data;
			expect(byRef).toEqual(bySha);
			expect(bySha.ref).toBe(`${s.slug}@v2`);
			expect(bySha.identityMd).toBe(s.v2.identityMd);
		});
	});

	it("resolves a deleted template's sha, but not its ref", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const bySha = await call(`/api/identity-versions/${s.goneV1.sha256}`);
			expect(bySha.status).toBe(200);
			expect(versionOne.parse(await bySha.json()).data.ref).toBe(
				`${s.goneSlug}@v1`,
			);
			const byRef = await call(`/api/identity-versions/${s.goneSlug}@v1`);
			expect(byRef.status).toBe(404);
		});
	});

	it("answers 404 for unknown and malformed refs", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			for (const ref of [
				"f".repeat(64),
				`${s.slug}@v9`,
				`${s.slug}@v0`,
				`${s.slug}@3`,
				`${s.slug}`,
				"nobody@v1",
			]) {
				const res = await call(`/api/identity-versions/${ref}`);
				expect([ref, res.status]).toEqual([ref, 404]);
			}
		});
	});

	it("answers 404 on the version reads of a deleted template", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			for (const path of ["identity/versions", "identity/versions/1"]) {
				const res = await call(`/api/agent-templates/${s.gone}/${path}`);
				expect(res.status).toBe(404);
			}
		});
	});
});
