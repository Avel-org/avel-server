import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	missionSkillSchema,
	pageEnvelope,
	presetSchema,
	rosterEntrySchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	agentTemplate,
	mission,
	missionSkills,
	rosterEntry,
	rosterPreset,
	skill,
	skillSource,
} from "../../src/db/schema";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

const roster = successEnvelope(rosterEntrySchema.array());
const missionSkillList = successEnvelope(missionSkillSchema.array());
const presetList = pageEnvelope(presetSchema);
const presetOne = successEnvelope(presetSchema);

function at(h: number) {
	return new Date(clock.now().getTime() + h * 3_600_000);
}

/** Two missions, their rosters and skills, and three presets, all under `ns`. */
async function seedLoadout(tx: Tx, ns: string) {
	let n = 0x900;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const stamped = (h: number) => ({ createdAt: at(h), updatedAt: at(h) });

	const newMission = async (h: number, deletedAt: Date | null = null) => {
		const missionId = id();
		await tx.insert(mission).values({
			id: missionId,
			origin: "internal",
			engagementId: null,
			type: "full-build",
			brief: {},
			sprintN: 1,
			status: "draft",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			deletedAt,
			...stamped(h),
		});
		return missionId;
	};
	const missionId = await newMission(0);
	const otherMission = await newMission(0);
	const deletedMission = await newMission(0, at(1));

	const newTemplate = async (slug: string, deletedAt: Date | null = null) => {
		const row = {
			id: id(),
			slug: `${ns}-${slug}`,
			name: slug,
			kind: "feature" as const,
			roles: ["domain" as const, "interface" as const],
			waveDefaults: ["B" as const],
			identityMd: "#",
			depthMd: "",
			writablePaths: ["src/**"],
			version: 1,
			deletedAt,
			...stamped(0),
		};
		await tx.insert(agentTemplate).values(row);
		return row;
	};
	const atlas = await newTemplate("atlas");
	// Deleted since it was put on the roster; the entry still names it.
	const retired = await newTemplate("retired", at(5));

	const entry = (
		h: number,
		values: Partial<typeof rosterEntry.$inferInsert> & {
			missionId: string;
			agentTemplateId: string;
		},
	) => ({
		id: id(),
		active: true,
		waves: ["B" as const],
		grain: "default" as const,
		absorbedBoundaries: [],
		...stamped(h),
		...values,
	});
	const first = entry(1, {
		missionId,
		agentTemplateId: atlas.id,
		estimatedTokens: 100_000,
		tokenSoftCeiling: 150_000,
		tokenHardCeiling: 300_000,
	});
	const second = entry(2, {
		missionId,
		agentTemplateId: retired.id,
		active: false,
		territory: "scheduling",
		writablePaths: ["src/scheduling/**"],
		customizedMd: "Focus on recurrence.",
		grain: "merged",
		absorbedBoundaries: ["calendar"],
	});
	const removed = entry(3, {
		missionId,
		agentTemplateId: atlas.id,
		deletedAt: at(4),
	});
	const elsewhere = entry(1, {
		missionId: otherMission,
		agentTemplateId: atlas.id,
	});
	await tx.insert(rosterEntry).values([first, second, removed, elsewhere]);

	const sourceId = id();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: `Internal ${ns}`,
		kind: "internal",
		...stamped(0),
	});
	const skillRow = (h: number, slug: string, extra: object = {}) => ({
		id: id(),
		slug: `${ns}-${slug}`,
		name: slug,
		description: "When to use it.",
		contentMd: "# Text\n",
		layer: "stack" as const,
		type: "knowledge" as const,
		grants: null,
		ioShape: null,
		recommendedFor: ["domain" as const],
		sourceId,
		contentSha256: "b".repeat(64),
		status: "approved" as const,
		version: 1,
		...stamped(h),
		...extra,
	});
	const drizzleSkill = skillRow(1, "drizzle");
	const bookingSkill = skillRow(2, "booking", { layer: "domain" });
	const goneSkill = skillRow(3, "gone", { deletedAt: at(4) });
	await tx.insert(skill).values([drizzleSkill, bookingSkill, goneSkill]);
	await tx.insert(missionSkills).values([
		{ missionId, skillId: bookingSkill.id, source: "manual" },
		{ missionId, skillId: drizzleSkill.id, source: "template" },
		{ missionId, skillId: goneSkill.id, source: "template" },
		{ missionId: otherMission, skillId: drizzleSkill.id, source: "pack" },
	]);

	const preset = (h: number, name: string, extra: object = {}) => ({
		id: id(),
		name: `${name} ${ns}`,
		description: null,
		cut: "vertical" as const,
		agents: [{ agent_template_id: atlas.id, waves: ["B" as const] }],
		version: 1,
		...stamped(h),
		...extra,
	});
	const lean = preset(1, "Lean");
	const full = preset(2, "Full", {
		description: "Every role covered.",
		cut: "horizontal",
		agents: [
			{
				agent_template_id: atlas.id,
				waves: ["A", "B"],
				territory: "payments",
				writable_paths: ["src/payments/**"],
				estimated_tokens: 80_000,
			},
		],
		version: 3,
	});
	const deletedPreset = preset(3, "Old", { deletedAt: at(4) });
	await tx.insert(rosterPreset).values([lean, full, deletedPreset]);

	return {
		missionId,
		deletedMission,
		atlas,
		retired,
		first,
		second,
		drizzleSkill,
		bookingSkill,
		lean,
		full,
		deletedPreset,
	};
}

describe.skipIf(!process.env.DATABASE_URL)("/api/missions/:id/roster", () => {
	afterAll(closeDb);

	it("answers the mission's live entries, oldest first, unpaginated", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seedLoadout(tx, ns);
			const res = await call(`/api/missions/${s.missionId}/roster`);
			expect(res.status).toBe(200);
			const body = roster.parse(await res.json());
			expect(body).not.toHaveProperty("meta");
			expect(body.data).toEqual([
				{
					id: s.first.id,
					missionId: s.missionId,
					agentTemplate: {
						id: s.atlas.id,
						slug: s.atlas.slug,
						name: "atlas",
						kind: "feature",
						roles: ["domain", "interface"],
					},
					active: true,
					waves: ["B"],
					customizedMd: null,
					writablePaths: null,
					territory: null,
					estimatedTokens: 100_000,
					tokenSoftCeiling: 150_000,
					tokenHardCeiling: 300_000,
					grain: "default",
					absorbedBoundaries: [],
					accessOverrides: null,
					createdAt: at(1).toISOString(),
					updatedAt: at(1).toISOString(),
				},
				{
					id: s.second.id,
					missionId: s.missionId,
					agentTemplate: {
						id: s.retired.id,
						slug: s.retired.slug,
						name: "retired",
						kind: "feature",
						roles: ["domain", "interface"],
					},
					active: false,
					waves: ["B"],
					customizedMd: "Focus on recurrence.",
					writablePaths: ["src/scheduling/**"],
					territory: "scheduling",
					estimatedTokens: null,
					tokenSoftCeiling: null,
					tokenHardCeiling: null,
					grain: "merged",
					absorbedBoundaries: ["calendar"],
					accessOverrides: null,
					createdAt: at(2).toISOString(),
					updatedAt: at(2).toISOString(),
				},
			]);
		});
	});

	it("404s a deleted or missing mission, and 400s a malformed id", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { deletedMission } = await seedLoadout(tx, ns);
			for (const path of [
				`/api/missions/${deletedMission}/roster`,
				`/api/missions/${ns}-0000-4000-8000-00000000ffff/roster`,
				`/api/missions/${deletedMission}/skills`,
			]) {
				const res = await call(path);
				expect(res.status).toBe(404);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"NOT_FOUND",
				);
			}
			expect((await call("/api/missions/nope/roster")).status).toBe(400);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/missions/:id/skills", () => {
	afterAll(closeDb);

	it("answers the mission's live skills with how each was attached", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seedLoadout(tx, ns);
			const res = await call(`/api/missions/${s.missionId}/skills`);
			expect(res.status).toBe(200);
			const body = missionSkillList.parse(await res.json());
			expect(
				body.data.map((m) => [m.skill.slug, m.skill.layer, m.source]),
			).toEqual([
				[s.drizzleSkill.slug, "stack", "template"],
				[s.bookingSkill.slug, "domain", "manual"],
			]);
			expect(body.data[0]?.skill.source.name).toBe(`Internal ${ns}`);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/presets", () => {
	afterAll(closeDb);

	it("lists live presets newest first, agents in camelCase with nulls", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seedLoadout(tx, ns);
			const res = await call(`/api/presets?q=${ns}`);
			expect(res.status).toBe(200);
			const body = presetList.parse(await res.json());
			expect(body.meta).toEqual({ nextCursor: null, total: 2 });
			expect(body.data.map((p) => p.id)).toEqual([s.full.id, s.lean.id]);
			expect(body.data[0]).toEqual({
				id: s.full.id,
				name: s.full.name,
				description: "Every role covered.",
				cut: "horizontal",
				agents: [
					{
						agentTemplateId: s.atlas.id,
						waves: ["A", "B"],
						territory: "payments",
						writablePaths: ["src/payments/**"],
						estimatedTokens: 80_000,
					},
				],
				version: 3,
				createdAt: at(2).toISOString(),
				updatedAt: at(2).toISOString(),
			});
			expect(body.data[1]?.agents).toEqual([
				{
					agentTemplateId: s.atlas.id,
					waves: ["B"],
					territory: null,
					writablePaths: null,
					estimatedTokens: null,
				},
			]);
		});
	});

	it("filters by cut, gets one, and 404s a deleted one", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seedLoadout(tx, ns);
			const vertical = presetList.parse(
				await (await call(`/api/presets?q=${ns}&cut=vertical`)).json(),
			);
			expect(vertical.data.map((p) => p.id)).toEqual([s.lean.id]);

			const got = await call(`/api/presets/${s.full.id}`);
			expect(got.status).toBe(200);
			expect(presetOne.parse(await got.json()).data.version).toBe(3);

			expect((await call(`/api/presets/${s.deletedPreset.id}`)).status).toBe(
				404,
			);
		});
	});
});
