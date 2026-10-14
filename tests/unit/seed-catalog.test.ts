import { describe, expect, it } from "vitest";
import {
	type AccessSkill,
	accessFor,
	createSkillBody,
	createSkillSourceBody,
	FIRM_ROLES,
	type Role,
} from "../../src/contract";
import { buildSeed, seedIds } from "../../src/db/seed/data";
import { skillContentSha256 } from "../../src/lib/skill-hash";
import { SEED_RUN_AT } from "./seed-run-at";

// The seeded skill catalog must be rows the API could have written, so the
// catalog pages show what a real operator would see.
describe("seed skill catalog", () => {
	const rows = buildSeed(seedIds(), SEED_RUN_AT);

	it("has one source of each kind, each one a valid create body", () => {
		expect(rows.skillSource.map((s) => s.kind).sort()).toEqual([
			"community",
			"internal",
			"vendor",
		]);
		for (const s of rows.skillSource) {
			expect(
				createSkillSourceBody.safeParse({
					name: s.name,
					kind: s.kind,
					url: s.url,
					license: s.license,
				}).success,
			).toBe(true);
		}
	});

	it("writes every skill as POST /api/skills would, hash included", () => {
		const sources = new Set(rows.skillSource.map((s) => s.id));
		for (const k of rows.skill) {
			const body = {
				slug: k.slug,
				name: k.name,
				description: k.description,
				contentMd: k.contentMd,
				avelEnhancementMd: k.avelEnhancementMd,
				layer: k.layer,
				type: k.type,
				recommendedFor: k.recommendedFor,
				sourceId: k.sourceId,
				...(k.type === "capability"
					? { grants: k.grants, ioShape: k.ioShape }
					: {}),
			};
			const parsed = createSkillBody.safeParse(body);
			expect(parsed.error?.issues ?? [], k.slug).toEqual([]);
			expect(k.contentSha256, k.slug).toBe(
				skillContentSha256({
					description: k.description,
					contentMd: k.contentMd,
					avelEnhancementMd: k.avelEnhancementMd ?? null,
					grants: k.grants ?? null,
					ioShape: k.ioShape ?? null,
					type: k.type,
					layer: k.layer,
				}),
			);
			expect(sources.has(k.sourceId), k.slug).toBe(true);
			const firm = k.recommendedFor.filter((r) =>
				(FIRM_ROLES as readonly Role[]).includes(r),
			);
			expect(firm, k.slug).toEqual([]);
			// The seed invents no users.
			expect([k.reviewedBy, k.reviewedAt], k.slug).toEqual([null, null]);
		}
	});

	it("covers every layer, status and type", () => {
		const seen = (f: "layer" | "status" | "type") =>
			[...new Set(rows.skill.map((k) => k[f]))].sort();
		expect(seen("layer")).toEqual(["domain", "role", "stack"]);
		expect(seen("status")).toEqual(["approved", "draft", "retired"]);
		expect(seen("type")).toEqual(["capability", "knowledge"]);
	});

	it("adds its rows after every earlier seed id, in one block", () => {
		// Rows added later still go after the catalog (the corrected roster
		// and its identities), so the check is: nothing else sits inside the
		// catalog's range, and something sits right before it.
		const seq = (id: string) => Number(id.slice(-12));
		const others = [
			...rows.client,
			...rows.engagement,
			...rows.connection,
			...rows.agentTemplate,
			...rows.agentIdentityVersion,
			...rows.rosterPreset,
			...rows.playbook,
			...rows.mission,
			...rows.rosterEntry,
			...rows.export,
			...rows.activityLog,
		].map((r) => seq(r.id as string));
		const catalog = [...rows.skillSource, ...rows.skill].map((r) =>
			seq(r.id as string),
		);
		const [lo, hi] = [Math.min(...catalog), Math.max(...catalog)];
		expect(hi - lo + 1).toBe(catalog.length);
		expect(others.filter((n) => n >= lo && n <= hi)).toEqual([]);
		expect(others).toContain(lo - 1);
	});

	it("keeps the mission ids avel-web references", () => {
		const byId = (id: string) => rows.mission.find((m) => m.id === id);
		expect(byId("3fcd1ce4-5eed-4000-8000-000000000036")).toMatchObject({
			type: "template-booking",
			templateRef: "template-booking",
			status: "draft",
		});
		expect(byId("fbd64a0e-5eed-4000-8000-000000000110")).toMatchObject({
			type: "discovery",
			templateRef: null,
			status: "draft",
		});
	});

	it("keeps the skill id avel-web references", () => {
		expect(
			rows.skill.find((k) => k.id === "c83884a9-5eed-4000-8000-000000000121")
				?.slug,
		).toBe("schema-inspector");
	});

	it("gives a seeded agent tool rows, one read and one held write", () => {
		const atlas = rows.agentTemplate.find((t) => t.slug === "atlas");
		if (!atlas) throw new Error("no atlas in the seed");
		const { rows: access } = accessFor({
			roles: atlas.roles,
			writablePaths: atlas.writablePaths,
			skills: rows.skill as AccessSkill[],
			roleSkills: rows.roleSkills,
			missionSkillIds: [],
		});
		expect(
			access.flatMap((r) =>
				r.kind === "grant" ? [`${r.skillSlug}/${r.grant}=${r.mode}`] : [],
			),
		).toEqual([
			"schema-inspector/db:read=read",
			"schema-inspector/db:migrate=write_held",
		]);
		const roleSkill = (id: string) => rows.skill.find((x) => x.id === id);
		for (const r of rows.roleSkills) {
			expect(roleSkill(r.skillId)?.layer).toBe("role");
		}
	});
});
