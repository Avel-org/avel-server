import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Role } from "../../src/contract/agent-template";
import { closeDb } from "../../src/db/client";
import {
	currentIdentity,
	identitySourceFor,
	identityState,
	identityStates,
	parseVersionRef,
	type RegenerateResult,
	regenerateIdentity,
	versionByNumber,
	versionByRef,
	versionsBySha,
	versionsFor,
} from "../../src/db/identity";
import {
	agentIdentityVersion,
	agentTemplate,
	roleSkills,
	skill,
	skillSource,
	user,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { identityInputs } from "../../src/lib/identity";
import type { IdGenerator } from "../../src/lib/ids";
import { clock, inRollback } from "./fixtures";

async function newTemplate(
	tx: Tx,
	ids: IdGenerator,
	roles: Role[] = ["domain"],
) {
	const id = ids.next();
	const slug = `atlas-${id}`;
	await tx.insert(agentTemplate).values({
		id,
		slug,
		name: "Atlas",
		kind: "feature",
		roles,
		waveDefaults: ["B"],
		writablePaths: ["src/modules/scheduling/**"],
		version: 1,
		...stamp(clock),
	});
	return { id, slug };
}

async function newOperator(tx: Tx, ids: IdGenerator) {
	const id = ids.next();
	await tx.insert(user).values({
		id,
		name: "Operator",
		email: `op-${id}@example.com`,
		emailVerified: true,
		githubId: id,
		githubLogin: "operator",
		...stamp(clock),
	});
	return id;
}

async function newSkill(
	tx: Tx,
	ids: IdGenerator,
	role: Role,
	status: "draft" | "approved" = "draft",
) {
	const sourceId = ids.next();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: "AVEL",
		kind: "internal",
		...stamp(clock),
	});
	const id = ids.next();
	await tx.insert(skill).values({
		id,
		slug: `skill-${id}`,
		name: "Service layering",
		description: "Keep services free of transport concerns.",
		contentMd: "# Service layering\n\nServices never import route handlers.",
		layer: "role",
		type: "knowledge",
		recommendedFor: [role],
		sourceId,
		contentSha256: "c".repeat(64),
		status,
		version: 1,
		...stamp(clock),
	});
	await tx.insert(roleSkills).values({ role, skillId: id });
	return id;
}

const regen = (
	tx: Tx,
	ids: IdGenerator,
	templateId: string,
	operatorId: string | null = null,
) => regenerateIdentity(tx, templateId, { clock, ids, operatorId });

function created(r: RegenerateResult | null) {
	if (!r || "refused" in r)
		throw new Error(`expected a version, got ${JSON.stringify(r)}`);
	return r;
}

async function setRoles(tx: Tx, templateId: string, roles: Role[]) {
	await tx
		.update(agentTemplate)
		.set({ roles })
		.where(eq(agentTemplate.id, templateId));
}

describe.skipIf(!process.env.DATABASE_URL)("identity data layer", () => {
	afterAll(closeDb);

	describe("identitySourceFor", () => {
		it("reads the template and every live role skill for its roles, any status", async () => {
			await inRollback(async (tx, ids) => {
				const t = await newTemplate(tx, ids, ["domain"]);
				const draft = await newSkill(tx, ids, "domain", "draft");
				const approved = await newSkill(tx, ids, "domain", "approved");
				await newSkill(tx, ids, "interface", "approved");
				const gone = await newSkill(tx, ids, "domain", "approved");
				await tx
					.update(skill)
					.set({ deletedAt: clock.now() })
					.where(eq(skill.id, gone));

				const source = await identitySourceFor(tx, t.id);
				expect(source).toMatchObject({
					slug: t.slug,
					name: "Atlas",
					kind: "feature",
					roles: ["domain"],
					writablePaths: ["src/modules/scheduling/**"],
				});
				expect(source?.roleSkills.map((s) => s.id).sort()).toEqual(
					[draft, approved].sort(),
				);
				expect(source?.roleSkills.find((s) => s.id === draft)?.status).toBe(
					"draft",
				);
			});
		});

		it("is null for an unknown or deleted template", async () => {
			await inRollback(async (tx, ids) => {
				const t = await newTemplate(tx, ids);
				await tx
					.update(agentTemplate)
					.set({ deletedAt: clock.now() })
					.where(eq(agentTemplate.id, t.id));
				expect(await identitySourceFor(tx, t.id)).toBeNull();
				expect(await identitySourceFor(tx, ids.next())).toBeNull();
			});
		});
	});

	it("reports a template never generated as not stale, with no version", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids);
			expect(await identityState(tx, t.id)).toEqual({
				version: null,
				stale: false,
				staleInputs: [],
			});
			expect(await currentIdentity(tx, t.id)).toBeNull();
		});
	});

	it("creates version 1 with the generator's output, the operator and the clock", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids);
			const op = await newOperator(tx, ids);
			const r = created(await regen(tx, ids, t.id, op));
			expect(r.created).toBe(true);
			expect(r.version).toMatchObject({
				agentTemplateId: t.id,
				number: 1,
				generatedBy: op,
				createdAt: clock.now(),
			});
			expect(r.version.identityMd).toContain(`# ${t.slug}`);
			expect(r.version.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(await identityState(tx, t.id)).toEqual({
				version: r.version,
				stale: false,
				staleInputs: [],
			});
		});
	});

	it("writes nothing when the sha equals the latest version", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids);
			const first = created(await regen(tx, ids, t.id));
			const again = created(await regen(tx, ids, t.id));
			expect(again).toEqual({ created: false, version: first.version });
			expect(await versionsFor(tx, t.id)).toHaveLength(1);
		});
	});

	it("goes stale on a roles change, then numbers the next version 2", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids, ["domain"]);
			const v1 = created(await regen(tx, ids, t.id)).version;
			await setRoles(tx, t.id, ["domain", "api-surface"]);

			const state = await identityState(tx, t.id);
			expect(state?.version?.id).toBe(v1.id);
			expect(state?.stale).toBe(true);
			expect(state?.staleInputs).toEqual(["roles", "definitionsSha256"]);

			const r = created(await regen(tx, ids, t.id));
			expect(r.created).toBe(true);
			expect(r.version.number).toBe(2);
			expect((await identityState(tx, t.id))?.stale).toBe(false);
			expect((await versionsFor(tx, t.id)).map((v) => v.number)).toEqual([
				2, 1,
			]);
		});
	});

	it("reuses version 1 when the inputs go A, B, then A again", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids, ["domain"]);
			const v1 = created(await regen(tx, ids, t.id)).version;
			await setRoles(tx, t.id, ["domain", "api-surface"]);
			const v2 = created(await regen(tx, ids, t.id)).version;
			await setRoles(tx, t.id, ["domain"]);

			// Current is the version matching the inputs, not the highest number.
			expect(await identityState(tx, t.id)).toEqual({
				version: v1,
				stale: false,
				staleInputs: [],
			});
			expect((await currentIdentity(tx, t.id))?.id).toBe(v1.id);

			expect(await regen(tx, ids, t.id)).toEqual({
				created: false,
				version: v1,
				reused: true,
			});
			expect((await versionsFor(tx, t.id)).map((v) => v.id)).toEqual([
				v2.id,
				v1.id,
			]);
		});
	});

	it("goes stale on skills when an attached role skill is approved", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids, ["domain"]);
			const s = await newSkill(tx, ids, "domain", "draft");
			const v1 = created(await regen(tx, ids, t.id)).version;
			expect(v1.identityMd).not.toContain("Service layering");

			await tx.update(skill).set({ status: "approved" }).where(eq(skill.id, s));
			const state = await identityState(tx, t.id);
			expect(state?.stale).toBe(true);
			expect(state?.staleInputs).toEqual(["skills"]);

			const v2 = created(await regen(tx, ids, t.id)).version;
			expect(v2.number).toBe(2);
			expect(v2.identityMd).toContain("Service layering");
		});
	});

	it("refuses the operator's template, writes nothing, and never reads it stale", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids, ["foundations"]);
			expect(await regen(tx, ids, t.id)).toEqual({
				refused: "identity_role_unsupported",
				roles: ["foundations"],
			});
			expect(await versionsFor(tx, t.id)).toEqual([]);
			expect(await identityState(tx, t.id)).toEqual({
				version: null,
				stale: false,
				staleInputs: [],
			});
		});
	});

	it("never reads the operator stale, even holding a version", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids, ["foundations"]);
			const [row] = await tx
				.insert(agentIdentityVersion)
				.values({
					id: ids.next(),
					agentTemplateId: t.id,
					number: 1,
					identityMd: "# operator\n",
					depthMd: "",
					sha256: "a".repeat(64),
					identityTokens: 3,
					depthTokens: 0,
					// Written by an older rule, before the template became the operator's.
					inputs: identityInputs({
						slug: t.slug,
						name: "Atlas",
						kind: "feature",
						roles: ["schema"],
						writablePaths: [],
						roleSkills: [],
					}),
					generatedBy: null,
					createdAt: clock.now(),
				})
				.returning();
			expect(await identityState(tx, t.id)).toEqual({
				version: row,
				stale: false,
				staleInputs: [],
			});
		});
	});

	it("returns null for a template that does not exist", async () => {
		await inRollback(async (tx, ids) => {
			expect(await regen(tx, ids, ids.next())).toBeNull();
		});
	});

	it("finds versions by number and by sha", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids);
			const v1 = created(await regen(tx, ids, t.id)).version;
			expect(await versionByNumber(tx, t.id, 1)).toEqual(v1);
			expect(await versionByNumber(tx, t.id, 2)).toBeNull();
			expect(await versionsBySha(tx, v1.sha256)).toEqual([v1]);
			expect(await versionsBySha(tx, "f".repeat(64))).toEqual([]);
		});
	});

	describe("refs", () => {
		it("parses slug@vN and refuses anything else", () => {
			expect(parseVersionRef("atlas@v3")).toEqual({ slug: "atlas", number: 3 });
			expect(parseVersionRef("atlas-scheduling@v12")).toEqual({
				slug: "atlas-scheduling",
				number: 12,
			});
			for (const bad of [
				"atlas",
				"atlas@v",
				"atlas@v0",
				"atlas@v01",
				"atlas@3",
				"atlas@V3",
				"@v1",
				"atlas@v1x",
				"atlas@v-1",
				"atlas@v2147483648",
				"atlas@v99999999999",
				"",
			]) {
				expect(parseVersionRef(bad), bad).toBeNull();
			}
		});

		it("resolves a ref against the live template's slug", async () => {
			await inRollback(async (tx, ids) => {
				const t = await newTemplate(tx, ids);
				const v1 = created(await regen(tx, ids, t.id)).version;
				expect(await versionByRef(tx, `${t.slug}@v1`)).toEqual(v1);
				expect(await versionByRef(tx, `${t.slug}@v2`)).toBeNull();
				expect(await versionByRef(tx, `nobody-${ids.next()}@v1`)).toBeNull();
				expect(await versionByRef(tx, t.slug)).toBeNull();

				await tx
					.update(agentTemplate)
					.set({ deletedAt: clock.now() })
					.where(eq(agentTemplate.id, t.id));
				expect(await versionByRef(tx, `${t.slug}@v1`)).toBeNull();
			});
		});
	});

	describe("identityStates", () => {
		it("returns each live template's state, leaving out unknown and deleted ids", async () => {
			await inRollback(async (tx, ids) => {
				const fresh = await newTemplate(tx, ids);
				const stale = await newTemplate(tx, ids);
				const never = await newTemplate(tx, ids);
				const deleted = await newTemplate(tx, ids);
				const vFresh = created(await regen(tx, ids, fresh.id)).version;
				const vStale = created(await regen(tx, ids, stale.id)).version;
				await setRoles(tx, stale.id, ["domain", "state"]);
				await tx
					.update(agentTemplate)
					.set({ deletedAt: clock.now() })
					.where(eq(agentTemplate.id, deleted.id));

				const states = await identityStates(tx, [
					fresh.id,
					stale.id,
					never.id,
					deleted.id,
					ids.next(),
				]);
				expect([...states.keys()].sort()).toEqual(
					[fresh.id, stale.id, never.id].sort(),
				);
				expect(states.get(fresh.id)).toEqual({
					version: vFresh,
					stale: false,
					staleInputs: [],
				});
				expect(states.get(stale.id)).toEqual({
					version: vStale,
					stale: true,
					staleInputs: ["roles", "definitionsSha256"],
				});
				expect(states.get(never.id)).toEqual({
					version: null,
					stale: false,
					staleInputs: [],
				});
			});
		});

		it("gives each template in a batch only the skills of its own roles", async () => {
			await inRollback(async (tx, ids) => {
				const builder = await newTemplate(tx, ids, ["domain"]);
				const screens = await newTemplate(tx, ids, ["interface"]);
				await newSkill(tx, ids, "domain", "approved");
				const vBuilder = created(await regen(tx, ids, builder.id)).version;
				const vScreens = created(await regen(tx, ids, screens.id)).version;
				expect(vBuilder.inputs.skills).toHaveLength(1);
				expect(vScreens.inputs.skills).toEqual([]);

				const states = await identityStates(tx, [builder.id, screens.id]);
				expect(states.get(builder.id)?.stale).toBe(false);
				expect(states.get(screens.id)?.stale).toBe(false);
			});
		});

		it("runs the same number of queries for one template as for many", async () => {
			await inRollback(async (tx, ids) => {
				const many = [];
				for (let i = 0; i < 4; i++) {
					const t = await newTemplate(tx, ids);
					await regen(tx, ids, t.id);
					many.push(t.id);
				}
				const spy = vi.spyOn(tx, "select");
				await identityStates(tx, many.slice(0, 1));
				const one = spy.mock.calls.length;
				spy.mockClear();
				await identityStates(tx, many);
				expect(spy.mock.calls.length).toBe(one);
				expect(one).toBe(3);
				spy.mockClear();
				expect(await identityStates(tx, [])).toEqual(new Map());
				expect(spy.mock.calls.length).toBe(0);
				spy.mockRestore();
			});
		});
	});

	it("leaves the version table append-only under regeneration", async () => {
		await inRollback(async (tx, ids) => {
			const t = await newTemplate(tx, ids, ["domain"]);
			const v1 = created(await regen(tx, ids, t.id)).version;
			await setRoles(tx, t.id, ["domain", "realtime"]);
			await regen(tx, ids, t.id);
			const [row] = await tx
				.select()
				.from(agentIdentityVersion)
				.where(eq(agentIdentityVersion.id, v1.id));
			expect(row).toEqual(v1);
		});
	});
});
