import { describe, expect, it } from "vitest";
import { computeCoherence } from "../../src/contract";
import { buildSeed, seedIds } from "../../src/db/seed/data";
import {
	generateIdentity,
	type IdentitySkill,
	identityInputs,
	staleInputs,
} from "../../src/lib/identity";

// The seeded roster follows ROSTER-V2's name register and J's rulings
// (2026-10-13): fifteen builder agents plus the operator, one cut per
// preset, and identities as the regenerate route would have written them.
describe("seed roster", () => {
	const rows = buildSeed(seedIds());
	const bySlug = new Map(rows.agentTemplate.map((t) => [t.slug, t]));
	const slugOf = (id: string) =>
		rows.agentTemplate.find((t) => t.id === id)?.slug;
	const LAYER_BUILDERS = ["leonora", "kel", "dunn", "gat", "ghost", "leon"];

	it("holds the operator and the fifteen agents of the register, and no others", () => {
		expect([...bySlug.keys()].sort()).toEqual(
			[
				"atlas",
				"brennan",
				"dunn",
				"fantem",
				"fenn",
				"gat",
				"ghost",
				"iyo",
				"kel",
				"kodie",
				"leon",
				"leonora",
				"nemi",
				"operator",
				"raze",
				"zane",
			].sort(),
		);
		expect(bySlug.get("operator")).toMatchObject({
			name: "Axis",
			title: "Operator",
			roles: ["foundations"],
		});
		expect(bySlug.get("atlas")?.kind).toBe("feature");
		const others = rows.agentTemplate.filter((t) => t.slug !== "atlas");
		expect(new Set(others.map((t) => t.kind))).toEqual(new Set(["horizontal"]));
		for (const t of rows.agentTemplate) {
			expect(t.title?.trim().length, t.slug).toBeGreaterThan(0);
			expect(t.title?.length, t.slug).toBeLessThanOrEqual(60);
		}
	});

	it("gives Gat the permission policy and Zane only findings", () => {
		expect(bySlug.get("gat")?.writablePaths).toContain(
			"permissions/policy.json",
		);
		for (const p of bySlug.get("zane")?.writablePaths ?? []) {
			expect(p).toMatch(/^findings\//);
		}
	});

	it("never puts Atlas and a layer builder in one preset", () => {
		for (const p of rows.rosterPreset) {
			const slugs = p.agents.map((a) => slugOf(a.agent_template_id));
			const atlas = slugs.includes("atlas");
			const layers = slugs.filter((s) => LAYER_BUILDERS.includes(s ?? ""));
			expect(atlas && layers.length > 0, p.name).toBe(false);
			expect(p.cut, p.name).toBe(atlas ? "vertical" : "horizontal");
		}
	});

	it("staffs every seeded mission's first wave", () => {
		const playbook = rows.playbook.find(
			(p) => p.missionType === "template-booking",
		);
		if (!playbook) throw new Error("no template-booking playbook");
		const missions = new Set(rows.rosterEntry.map((e) => e.missionId));
		for (const missionId of missions) {
			const m = rows.mission.find((x) => x.id === missionId);
			const roster = rows.rosterEntry
				.filter((e) => e.missionId === missionId)
				.map((e) => {
					const t = rows.agentTemplate.find((x) => x.id === e.agentTemplateId);
					if (!t) throw new Error("entry without template");
					return {
						id: e.id,
						active: e.active,
						waves: e.waves,
						kind: t.kind,
						roles: t.roles,
						writablePaths: e.writablePaths ?? t.writablePaths,
					};
				});
			const result = computeCoherence(
				{ cut: m?.cut ?? "vertical", roster },
				playbook,
			);
			expect(
				result.block,
				`${m?.repoUrl} sprint ${m?.sprintN}`,
			).toBeUndefined();
			// Vertical missions use Atlas, never a layer builder.
			const slugs = rows.rosterEntry
				.filter((e) => e.missionId === missionId)
				.map((e) => slugOf(e.agentTemplateId));
			expect(slugs.filter((s) => LAYER_BUILDERS.includes(s ?? ""))).toEqual([]);
		}
	});

	describe("identity versions", () => {
		const versionsOf = (slug: string) =>
			rows.agentIdentityVersion
				.filter((v) => v.agentTemplateId === bySlug.get(slug)?.id)
				.map((v) => v);
		const skillsFor = (roles: readonly string[]): IdentitySkill[] => {
			const ids = new Set(
				rows.roleSkills
					.filter((r) => roles.includes(r.role))
					.map((r) => r.skillId),
			);
			return rows.skill
				.filter((s) => ids.has(s.id))
				.map((s) => ({
					id: s.id,
					slug: s.slug,
					name: s.name,
					description: s.description,
					contentMd: s.contentMd,
					avelEnhancementMd: s.avelEnhancementMd ?? null,
					contentSha256: s.contentSha256,
					status: s.status ?? "draft",
				}));
		};
		const sourceOf = (slug: string) => {
			const t = bySlug.get(slug);
			if (!t) throw new Error(`no ${slug}`);
			return {
				slug: t.slug,
				name: t.name,
				kind: t.kind,
				roles: t.roles,
				writablePaths: t.writablePaths,
				roleSkills: skillsFor(t.roles),
			};
		};

		it("gives each model agent a version 1 and the operator none", () => {
			expect(versionsOf("operator")).toEqual([]);
			for (const slug of bySlug.keys()) {
				if (slug === "operator") continue;
				expect(
					versionsOf(slug).map((v) => v.number),
					slug,
				).toEqual(slug === "kel" ? [1, 2] : [1]);
			}
		});

		it("stores exactly what the generator writes for each version", () => {
			for (const v of rows.agentIdentityVersion) {
				const slug = slugOf(v.agentTemplateId) ?? "";
				const g = generateIdentity({
					...sourceOf(slug),
					writablePaths: v.inputs.writablePaths,
				});
				if ("refused" in g) throw new Error(`${slug}: ${g.refused}`);
				expect(
					[v.sha256, v.identityMd, v.depthMd, v.inputs],
					`${slug} v${v.number}`,
				).toEqual([g.sha256, g.identityMd, g.depthMd, g.inputs]);
			}
		});

		it("leaves Raze stale on its paths, and every other agent current", () => {
			for (const slug of bySlug.keys()) {
				if (slug === "operator") continue;
				const g = generateIdentity(sourceOf(slug));
				if ("refused" in g) throw new Error(`${slug}: ${g.refused}`);
				const latest = versionsOf(slug).at(-1);
				if (!latest) throw new Error(`${slug} has no version`);
				if (slug === "raze") {
					expect(latest.sha256).not.toBe(g.sha256);
					expect(
						staleInputs(latest.inputs, identityInputs(sourceOf(slug))),
					).toEqual(["writablePaths"]);
				} else {
					expect(latest.sha256, slug).toBe(g.sha256);
				}
			}
		});

		it("logs Kel's and Raze's edits as the PATCH would", () => {
			const updated = rows.activityLog
				.filter((a) => a.action === "agent_template.updated")
				.map((a) => ({
					slug: slugOf(a.entityId),
					at: a.at,
					entityType: a.entityType,
					payload: a.payload,
				}));
			expect(updated).toEqual(
				["kel", "raze"].map((slug) => ({
					slug,
					at: bySlug.get(slug)?.updatedAt,
					entityType: "agent_template",
					payload: { seed: true, fields: ["writablePaths"], version: 2 },
				})),
			);
			for (const slug of ["kel", "raze"]) {
				expect(bySlug.get(slug)?.version, slug).toBe(2);
			}
		});

		it("logs one regeneration per version", () => {
			const logged = rows.activityLog.filter(
				(a) => a.action === "agent_template.identity_regenerated",
			);
			expect(logged).toHaveLength(rows.agentIdentityVersion.length);
			for (const v of rows.agentIdentityVersion) {
				expect(
					logged.some(
						(a) =>
							a.entityId === v.agentTemplateId &&
							(a.payload as { sha256?: string }).sha256 === v.sha256,
					),
				).toBe(true);
			}
		});
	});
});
