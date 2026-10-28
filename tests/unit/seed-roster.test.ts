import { describe, expect, it } from "vitest";
import { computeCoherence } from "../../src/contract";
import { buildSeed, seedIds } from "../../src/db/seed/data";
import { generateIdentity } from "../../src/lib/identity";

// The seeded roster follows ROSTER-V2's name register and J's rulings
// (2026-10-13): fifteen builder agents plus the operator, one cut per
// preset, and identities as the regenerate route would have written them.
describe("seed roster", () => {
	const rows = buildSeed(seedIds());
	const bySlug = new Map(rows.agentTemplate.map((t) => [t.slug, t]));
	const slugOf = (id: string) =>
		rows.agentTemplate.find((t) => t.id === id)?.slug;
	const LAYER_BUILDERS = ["leonora", "kel", "dunn", "gat", "ghost", "leon"];

	it("holds the operator, the fifteen agents of the register and Canon, and no others", () => {
		expect([...bySlug.keys()].sort()).toEqual(
			[
				"atlas",
				"brennan",
				// Canon, the project briefer (2026-10-19): on no roster.
				"canon",
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

	it("staffs the first wave with every preset applied as it stands", () => {
		const playbook = rows.playbook.find(
			(p) => p.missionType === "template-booking",
		);
		if (!playbook) throw new Error("no template-booking playbook");
		for (const p of rows.rosterPreset) {
			const roster = p.agents.map((a, i) => {
				const t = rows.agentTemplate.find((x) => x.id === a.agent_template_id);
				if (!t) throw new Error(`${p.name}: agent without template`);
				return {
					id: `${p.name}:${i}`,
					active: true,
					waves: a.waves,
					kind: t.kind,
					roles: t.roles,
					writablePaths: a.writable_paths ?? t.writablePaths,
				};
			});
			const result = computeCoherence({ cut: p.cut, roster }, playbook);
			expect(result.block, p.name).toBeUndefined();
		}
	});

	describe("identity versions", () => {
		const versionsOf = (slug: string) =>
			rows.agentIdentityVersion
				.filter((v) => v.agentTemplateId === bySlug.get(slug)?.id)
				.map((v) => v);
		const sourceOf = (slug: string) => {
			const t = bySlug.get(slug);
			if (!t) throw new Error(`no ${slug}`);
			return {
				slug: t.slug,
				name: t.name,
				kind: t.kind,
				roles: t.roles,
				writablePaths: t.writablePaths,
				roleSkills: [],
			};
		};

		it("gives each model agent and Canon a version 1 and the operator none", () => {
			expect(versionsOf("operator")).toEqual([]);
			for (const slug of bySlug.keys()) {
				if (slug === "operator") continue;
				expect(
					versionsOf(slug).map((v) => v.number),
					slug,
				).toEqual([1]);
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

		it("leaves every agent current: no template changed after its identity", () => {
			for (const slug of bySlug.keys()) {
				if (slug === "operator") continue;
				const g = generateIdentity(sourceOf(slug));
				if ("refused" in g) throw new Error(`${slug}: ${g.refused}`);
				expect(versionsOf(slug).at(-1)?.sha256, slug).toBe(g.sha256);
				expect(bySlug.get(slug)?.version, slug).toBe(1);
			}
		});
	});
});
