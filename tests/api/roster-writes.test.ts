import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	missionSkillSchema,
	removedSchema,
	rosterEntrySchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	mission,
	rosterEntry,
	rosterPreset,
	skill,
	skillSource,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const entryOne = successEnvelope(rosterEntrySchema);
const roster = successEnvelope(rosterEntrySchema.array());
const missionSkillOne = successEnvelope(missionSkillSchema);
const removed = successEnvelope(removedSchema);

type Call = ApiHarness["call"];

async function expectFailure(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe(code);
	return error;
}

async function expectReason(res: Response, reason: string) {
	const error = await expectFailure(res, 422, "PRECONDITION_FAILED");
	expect(error.details).toEqual({ reason });
}

/** Missions, templates, skills and presets under `ns`. */
async function seed(tx: Tx, ns: string) {
	let n = 0x900;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const newMission = async (
		status: "draft" | "active",
		deletedAt: Date | null = null,
	) => {
		const missionId = id();
		await tx.insert(mission).values({
			id: missionId,
			origin: "internal",
			engagementId: null,
			type: "full-build",
			brief: {},
			sprintN: 1,
			status,
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			deletedAt,
			...stamp(clock),
		});
		return missionId;
	};
	const draft = await newMission("draft");
	const otherDraft = await newMission("draft");
	const active = await newMission("active");
	const deletedMission = await newMission("draft", clock.now());

	const newTemplate = async (
		slug: string,
		roles: (typeof agentTemplate.$inferInsert)["roles"],
		deletedAt: Date | null = null,
	) => {
		const templateId = id();
		await tx.insert(agentTemplate).values({
			id: templateId,
			slug: `${ns}-${slug}`,
			name: slug,
			kind: "feature",
			roles,
			waveDefaults: ["B"],
			identityMd: "#",
			depthMd: "",
			writablePaths: ["src/**"],
			version: 1,
			deletedAt,
			...stamp(clock),
		});
		return templateId;
	};
	const atlas = await newTemplate("atlas", ["domain", "interface"]);
	const fenn = await newTemplate("fenn", ["backend-tests"]);
	const canon = await newTemplate("canon", ["intake", "strategy"]);
	const gone = await newTemplate("gone", ["domain"], clock.now());

	const sourceId = id();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: `Source ${ns}`,
		kind: "internal",
		...stamp(clock),
	});
	const newSkill = async (
		slug: string,
		status: "draft" | "approved",
		layer: "role" | "stack" | "domain",
	) => {
		const skillId = id();
		await tx.insert(skill).values({
			id: skillId,
			slug: `${ns}-${slug}`,
			name: slug,
			description: "When to use it.",
			contentMd: "#",
			layer,
			type: "knowledge",
			recommendedFor: ["domain"],
			sourceId,
			contentSha256: "c".repeat(64),
			status,
			version: 1,
			...stamp(clock),
		});
		return skillId;
	};
	const approved = await newSkill("approved", "approved", "stack");
	const draftSkill = await newSkill("draft", "draft", "stack");
	const roleSkill = await newSkill("role", "approved", "role");

	const newPreset = async (
		agents: (typeof rosterPreset.$inferInsert)["agents"],
		deletedAt: Date | null = null,
	) => {
		const presetId = id();
		await tx.insert(rosterPreset).values({
			id: presetId,
			name: `Preset ${ns}`,
			cut: "vertical",
			agents,
			version: 2,
			deletedAt,
			...stamp(clock),
		});
		return presetId;
	};
	const squad = await newPreset([
		{ agent_template_id: atlas, waves: ["B"] },
		{
			agent_template_id: atlas,
			waves: ["B", "C"],
			territory: "payments",
			writable_paths: ["src/payments/**"],
			estimated_tokens: 80_000,
		},
		{ agent_template_id: fenn, waves: ["C"] },
	]);
	const firmPreset = await newPreset([
		{ agent_template_id: atlas, waves: ["B"] },
		{ agent_template_id: canon, waves: ["A"] },
	]);
	const twice = await newPreset([
		{ agent_template_id: fenn, waves: ["C"] },
		{ agent_template_id: fenn, waves: ["D"] },
	]);
	const deletedPreset = await newPreset([], clock.now());

	return {
		draft,
		otherDraft,
		active,
		deletedMission,
		atlas,
		fenn,
		canon,
		gone,
		approved,
		draftSkill,
		roleSkill,
		squad,
		firmPreset,
		twice,
		deletedPreset,
	};
}

async function add(call: Call, missionId: string, body: object) {
	return call(`/api/missions/${missionId}/roster`, { method: "POST", body });
}

describe.skipIf(!process.env.DATABASE_URL)("roster add", () => {
	afterAll(closeDb);

	it("adds a template with defaults, and logs it against the mission", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await add(call, s.draft, { agentTemplateId: s.atlas });
			expect(res.status).toBe(201);
			const entry = entryOne.parse(await res.json()).data;
			expect(entry).toMatchObject({
				missionId: s.draft,
				agentTemplate: { id: s.atlas, roles: ["domain", "interface"] },
				active: true,
				waves: ["B"],
				customizedMd: null,
				writablePaths: null,
				territory: null,
				estimatedTokens: null,
				tokenSoftCeiling: null,
				tokenHardCeiling: null,
				grain: "default",
				absorbedBoundaries: [],
				createdAt: clock.now().toISOString(),
			});
			const logs = await logRows(entry.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				action: "roster.entry_added",
				entityType: "roster_entry",
				missionId: s.draft,
				actorKind: "operator",
			});
		});
	});

	it("defaults ceilings from the estimate, and keeps an explicit null", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const defaulted = entryOne.parse(
				await (
					await add(call, s.draft, {
						agentTemplateId: s.atlas,
						estimatedTokens: 100_001,
					})
				).json(),
			).data;
			expect(defaulted).toMatchObject({
				estimatedTokens: 100_001,
				tokenSoftCeiling: 150_002,
				tokenHardCeiling: 300_003,
			});
			const kept = entryOne.parse(
				await (
					await add(call, s.draft, {
						agentTemplateId: s.fenn,
						estimatedTokens: 10,
						tokenSoftCeiling: null,
					})
				).json(),
			).data;
			expect(kept).toMatchObject({
				tokenSoftCeiling: null,
				tokenHardCeiling: 30,
			});
		});
	});

	it("allows a template once per territory", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			expect(
				(await add(call, s.draft, { agentTemplateId: s.atlas })).status,
			).toBe(201);
			await expectFailure(
				await add(call, s.draft, { agentTemplateId: s.atlas }),
				409,
				"CONFLICT",
			);
			const scoped = { agentTemplateId: s.atlas, territory: "payments" };
			expect((await add(call, s.draft, scoped)).status).toBe(201);
			await expectFailure(await add(call, s.draft, scoped), 409, "CONFLICT");
			// Another mission's roster is its own.
			expect(
				(await add(call, s.otherDraft, { agentTemplateId: s.atlas })).status,
			).toBe(201);
		});
	});

	it("refuses Firm, deleted and missing templates with 422", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await expectReason(
				await add(call, s.draft, { agentTemplateId: s.canon }),
				"template_not_rosterable",
			);
			for (const agentTemplateId of [
				s.gone,
				`${ns}-0000-4000-8000-00000000ffff`,
			]) {
				await expectReason(
					await add(call, s.draft, { agentTemplateId }),
					"agent_template_not_found",
				);
			}
		});
	});

	it("refuses a mission that is not a draft with 422, and a deleted one with 404", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await expectReason(
				await add(call, s.active, { agentTemplateId: s.atlas }),
				"mission_not_editable",
			);
			await expectFailure(
				await add(call, s.deletedMission, { agentTemplateId: s.atlas }),
				404,
				"NOT_FOUND",
			);
		});
	});

	it("refuses an inconsistent entry with 400 and names the field", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			for (const [body, path] of [
				[{ grain: "merged" }, "absorbedBoundaries"],
				[{ absorbedBoundaries: ["calendar"] }, "absorbedBoundaries"],
				[{ estimatedTokens: 100, tokenSoftCeiling: 50 }, "tokenSoftCeiling"],
			] as const) {
				const error = await expectFailure(
					await add(call, s.draft, { agentTemplateId: s.atlas, ...body }),
					400,
					"VALIDATION_FAILED",
				);
				expect(error.details).toMatchObject({ body: [{ path: [path] }] });
			}
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("roster update and remove", () => {
	afterAll(closeDb);

	it("updates an entry, checking the whole entry, and logs field names", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns);
			const entry = entryOne.parse(
				await (await add(call, s.draft, { agentTemplateId: s.atlas })).json(),
			).data;
			const path = `/api/missions/${s.draft}/roster/${entry.id}`;

			const merged = await call(path, {
				method: "PATCH",
				body: {
					grain: "merged",
					absorbedBoundaries: ["calendar"],
					active: false,
				},
			});
			expect(merged.status).toBe(200);
			expect(entryOne.parse(await merged.json()).data).toMatchObject({
				grain: "merged",
				absorbedBoundaries: ["calendar"],
				active: false,
			});

			// Leaving merged without dropping the boundaries breaks the stored entry.
			await expectFailure(
				await call(path, { method: "PATCH", body: { grain: "default" } }),
				400,
				"VALIDATION_FAILED",
			);
			await expectFailure(
				await call(path, { method: "PATCH", body: {} }),
				400,
				"VALIDATION_FAILED",
			);

			const updates = (await logRows(entry.id)).filter(
				(l) => l.action === "roster.entry_updated",
			);
			expect(updates.map((l) => l.payload)).toEqual([
				{ fields: ["absorbedBoundaries", "active", "grain"] },
			]);
		});
	});

	it("refuses a territory change onto a taken one, and another mission's entry", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await add(call, s.draft, {
				agentTemplateId: s.atlas,
				territory: "payments",
			});
			const second = entryOne.parse(
				await (await add(call, s.draft, { agentTemplateId: s.atlas })).json(),
			).data;
			await expectFailure(
				await call(`/api/missions/${s.draft}/roster/${second.id}`, {
					method: "PATCH",
					body: { territory: "payments" },
				}),
				409,
				"CONFLICT",
			);
			await expectFailure(
				await call(`/api/missions/${s.otherDraft}/roster/${second.id}`, {
					method: "PATCH",
					body: { active: false },
				}),
				404,
				"NOT_FOUND",
			);
		});
	});

	it("removes an entry once", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const entry = entryOne.parse(
				await (await add(call, s.draft, { agentTemplateId: s.atlas })).json(),
			).data;
			const path = `/api/missions/${s.draft}/roster/${entry.id}`;
			const res = await call(path, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(removed.parse(await res.json()).data).toEqual({ id: entry.id });
			const list = roster.parse(
				await (await call(`/api/missions/${s.draft}/roster`)).json(),
			);
			expect(list.data).toEqual([]);
			await expectFailure(
				await call(path, { method: "DELETE" }),
				404,
				"NOT_FOUND",
			);
			// The template can go back on once removed.
			expect(
				(await add(call, s.draft, { agentTemplateId: s.atlas })).status,
			).toBe(201);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("roster applyPreset", () => {
	afterAll(closeDb);

	const apply = (call: Call, missionId: string, body: object) =>
		call(`/api/missions/${missionId}/roster/apply-preset`, {
			method: "POST",
			body,
		});

	it("copies the preset into entries, with defaults, and logs the apply", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await apply(call, s.draft, { presetId: s.squad });
			expect(res.status).toBe(200);
			const { data } = roster.parse(await res.json());
			expect(
				data.map((e) => [e.agentTemplate.id, e.territory, e.waves]),
			).toEqual([
				[s.atlas, null, ["B"]],
				[s.atlas, "payments", ["B", "C"]],
				[s.fenn, null, ["C"]],
			]);
			expect(data[1]).toMatchObject({
				writablePaths: ["src/payments/**"],
				estimatedTokens: 80_000,
				tokenSoftCeiling: 120_000,
				tokenHardCeiling: 240_000,
				active: true,
				grain: "default",
			});
			const [applied] = (await logRows(s.draft)).filter(
				(l) => l.action === "roster.preset_applied",
			);
			expect(applied?.payload).toEqual({
				presetId: s.squad,
				presetVersion: 2,
				added: data.map((e) => e.id),
				removed: [],
			});
		});
	});

	it("refuses a mission with a roster unless replace, and replaces it when asked", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const first = entryOne.parse(
				await (await add(call, s.draft, { agentTemplateId: s.fenn })).json(),
			).data;
			await expectReason(
				await apply(call, s.draft, { presetId: s.squad }),
				"roster_not_empty",
			);
			const res = await apply(call, s.draft, {
				presetId: s.squad,
				replace: true,
			});
			expect(res.status).toBe(200);
			const { data } = roster.parse(await res.json());
			expect(data).toHaveLength(3);
			expect(data.map((e) => e.id)).not.toContain(first.id);
			const [old] = await tx
				.select()
				.from(rosterEntry)
				.where(eq(rosterEntry.id, first.id));
			expect(old?.deletedAt).not.toBeNull();
		});
	});

	it("writes nothing when any template is not rosterable, or the preset is gone", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await expectReason(
				await apply(call, s.draft, { presetId: s.firmPreset }),
				"template_not_rosterable",
			);
			await expectReason(
				await apply(call, s.draft, { presetId: s.deletedPreset }),
				"preset_not_found",
			);
			await expectFailure(
				await apply(call, s.draft, { presetId: s.twice }),
				409,
				"CONFLICT",
			);
			await expectReason(
				await apply(call, s.active, { presetId: s.squad }),
				"mission_not_editable",
			);
			const rows = await tx
				.select()
				.from(rosterEntry)
				.where(eq(rosterEntry.missionId, s.draft));
			expect(rows).toEqual([]);
			const logs = await tx
				.select()
				.from(activityLog)
				.where(eq(activityLog.missionId, s.draft));
			expect(logs).toEqual([]);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)(
	"mission skill attach and detach",
	() => {
		afterAll(closeDb);

		const attach = (call: Call, missionId: string, skillId: string) =>
			call(`/api/missions/${missionId}/skills`, {
				method: "POST",
				body: { skillId },
			});

		it("attaches an approved stack skill once, and detaches it once", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const s = await seed(tx, ns);
				const res = await attach(call, s.draft, s.approved);
				expect(res.status).toBe(201);
				expect(missionSkillOne.parse(await res.json()).data).toMatchObject({
					skill: { id: s.approved, status: "approved", layer: "stack" },
					source: "manual",
				});
				await expectFailure(
					await attach(call, s.draft, s.approved),
					409,
					"CONFLICT",
				);

				const path = `/api/missions/${s.draft}/skills/${s.approved}`;
				const detached = await call(path, { method: "DELETE" });
				expect(detached.status).toBe(200);
				expect(removed.parse(await detached.json()).data).toEqual({
					id: s.approved,
				});
				await expectFailure(
					await call(path, { method: "DELETE" }),
					404,
					"NOT_FOUND",
				);

				const actions = (await logRows(s.draft)).map((l) => [
					l.action,
					l.payload,
				]);
				expect(actions).toEqual([
					["mission.skill_attached", { skillId: s.approved, source: "manual" }],
					["mission.skill_detached", { skillId: s.approved, source: "manual" }],
				]);
			});
		});

		it("refuses draft, role-layer and missing skills, and non-draft missions", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = await seed(tx, ns);
				await expectReason(
					await attach(call, s.draft, s.draftSkill),
					"skill_not_attachable",
				);
				await expectReason(
					await attach(call, s.draft, s.roleSkill),
					"skill_not_attachable",
				);
				await expectReason(
					await attach(call, s.draft, `${ns}-0000-4000-8000-00000000ffff`),
					"skill_not_found",
				);
				await expectReason(
					await attach(call, s.active, s.approved),
					"mission_not_editable",
				);
			});
		});
	},
);
