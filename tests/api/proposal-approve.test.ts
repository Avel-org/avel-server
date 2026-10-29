import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	preconditionDetails,
	proposalSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	playbook,
	proposal,
	rosterPreset,
} from "../../src/db/schema";
import { live, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

// Approving Canon's playbook and preset proposals (J, 2026-10-28: Canon
// drafts, the operator approves). The proposals are inserted as Canon's
// draft_playbook and draft_preset tools write them.

const approved = successEnvelope(proposalSchema);

async function reasonOf(res: Response) {
	expect(res.status, await res.clone().text()).toBe(422);
	return preconditionDetails.parse(
		errorEnvelope.parse(await res.json()).error.details,
	).reason;
}

async function seed(tx: Tx, ns: string) {
	let n = 0xe00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const templateId = id();
	await tx.insert(agentTemplate).values({
		id: templateId,
		slug: `${ns}-leon`,
		name: "leon",
		kind: "feature",
		roles: ["domain", "interface"],
		waveDefaults: ["A"],
		writablePaths: ["src/**"],
		version: 1,
		deletedAt: null,
		...stamp(clock),
	});
	const preset = (name: string) => ({
		name,
		description: null,
		cut: "vertical" as const,
		agents: [
			{
				agentTemplateId: templateId,
				waves: ["A" as const, "B" as const],
				territory: "gts-sections",
				writablePaths: ["src/sections/**"],
				estimatedTokens: null,
			},
		],
	});
	const fields = (missionType: string) => ({
		missionType,
		name: "Landing page",
		wavesApplicable: ["A" as const, "B" as const],
		gates: [
			{ gate: "acceptance" as const, policy: "mandatory" as const },
			{ gate: "qa" as const, policy: "mandatory" as const },
			{ gate: "security" as const, policy: "mandatory" as const },
		],
		deliverable: "pr" as const,
		requiredFields: ["brief", "repoUrl", "consent"],
	});
	const insert = async (
		kind: "playbook" | "preset" | "calibration",
		payload: unknown,
	) => {
		const proposalId = id();
		await tx.insert(proposal).values({
			id: proposalId,
			kind,
			source: "model",
			summary: `A ${kind}`,
			payload,
			premise: { canonSessionId: id(), intakeId: id(), reason: "Asked" },
			status: "pending",
			...stamp(clock),
		});
		return proposalId;
	};
	return { id, templateId, preset, fields, insert };
}

describe.skipIf(!process.env.DATABASE_URL)("approving a proposal", () => {
	afterAll(closeDb);

	it("writes a new playbook and its new preset in one transaction, as the operator", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const s = await seed(h.tx, h.ns);
			const type = `landing-page-${h.ns}`;
			const proposalId = await s.insert("playbook", {
				playbook: { ...s.fields(type), defaultPresetId: null },
				newPreset: s.preset("Landing page"),
				replacesVersion: null,
			});
			const res = await h.call(`/api/proposals/${proposalId}/approve`, {
				method: "POST",
			});
			expect(res.status, await res.clone().text()).toBe(200);
			const wire = approved.parse(await res.json()).data;
			const operator = await h.operatorId();
			expect(wire).toMatchObject({
				status: "approved",
				decidedBy: operator,
				decidedAt: clock.now().toISOString(),
			});

			const [written] = await h.tx
				.select()
				.from(playbook)
				.where(and(eq(playbook.missionType, type), live(playbook)));
			expect(written).toMatchObject({
				name: "Landing page",
				version: 1,
				gates: s.fields(type).gates,
				requiredFields: ["brief", "repoUrl", "consent"],
			});
			const [preset] = await h.tx
				.select()
				.from(rosterPreset)
				.where(eq(rosterPreset.id, written?.defaultPresetId ?? ""));
			expect(preset).toMatchObject({
				name: "Landing page",
				agents: [
					{
						agent_template_id: s.templateId,
						waves: ["A", "B"],
						territory: "gts-sections",
						writable_paths: ["src/sections/**"],
					},
				],
			});

			const [decided] = await h.logRows(proposalId);
			expect(decided).toMatchObject({
				action: "proposal.approved",
				actorKind: "operator",
				actorUserId: operator,
				payload: {
					kind: "playbook",
					playbookId: written?.id,
					presetId: preset?.id,
				},
			});
			// The writes log as the routes' own, with the approving operator as actor.
			const writes = await h.tx
				.select({ action: activityLog.action, actor: activityLog.actorUserId })
				.from(activityLog)
				.where(eq(activityLog.requestId, decided?.requestId ?? ""))
				.orderBy(activityLog.id);
			expect(writes.map((w) => w.action).sort()).toEqual([
				"playbook.created",
				"preset.created",
				"proposal.approved",
			]);
			expect(new Set(writes.map((w) => w.actor))).toEqual(new Set([operator]));

			const again = await h.call(`/api/proposals/${proposalId}/approve`, {
				method: "POST",
			});
			expect(await reasonOf(again)).toBe("proposal_not_pending");
		});
	});

	it("writes a preset proposal as POST /api/presets would", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const s = await seed(h.tx, h.ns);
			const proposalId = await s.insert("preset", {
				preset: s.preset(`Squad ${h.ns}`),
			});
			const res = await h.call(`/api/proposals/${proposalId}/approve`, {
				method: "POST",
			});
			expect(res.status, await res.clone().text()).toBe(200);
			const [decided] = await h.logRows(proposalId);
			const presetId = (decided?.payload as { presetId: string }).presetId;
			const [row] = await h.tx
				.select()
				.from(rosterPreset)
				.where(eq(rosterPreset.id, presetId));
			expect(row).toMatchObject({ name: `Squad ${h.ns}`, version: 1 });
		});
	});

	it("replaces the live playbook only at the version Canon drafted against", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const s = await seed(h.tx, h.ns);
			const type = `landing-page-${h.ns}`;
			const first = await s.insert("playbook", {
				playbook: { ...s.fields(type), defaultPresetId: null },
				newPreset: s.preset("First"),
				replacesVersion: null,
			});
			expect(
				(await h.call(`/api/proposals/${first}/approve`, { method: "POST" }))
					.status,
			).toBe(200);
			const [v1] = await h.tx
				.select()
				.from(playbook)
				.where(and(eq(playbook.missionType, type), live(playbook)));
			if (!v1) throw new Error("no playbook");
			const { missionType: _type, ...replacement } = {
				...s.fields(type),
				name: "Landing page, revised",
			};

			const stale = await s.insert("playbook", {
				playbook: {
					...replacement,
					missionType: type,
					defaultPresetId: null,
				},
				newPreset: s.preset("Stale"),
				replacesVersion: 7,
			});
			const presetsBefore = await h.tx
				.select({ id: rosterPreset.id })
				.from(rosterPreset);
			expect(
				await reasonOf(
					await h.call(`/api/proposals/${stale}/approve`, { method: "POST" }),
				),
			).toBe("proposal_premise_changed");
			// Refused whole: no preset was left behind, and the proposal is still pending.
			expect(
				await h.tx.select({ id: rosterPreset.id }).from(rosterPreset),
			).toHaveLength(presetsBefore.length);
			const [still] = await h.tx
				.select({ status: proposal.status })
				.from(proposal)
				.where(eq(proposal.id, stale));
			expect(still?.status).toBe("pending");

			const current = await s.insert("playbook", {
				playbook: {
					...replacement,
					missionType: type,
					defaultPresetId: v1.defaultPresetId,
				},
				newPreset: null,
				replacesVersion: 1,
			});
			const res = await h.call(`/api/proposals/${current}/approve`, {
				method: "POST",
			});
			expect(res.status, await res.clone().text()).toBe(200);
			const [v2] = await h.tx
				.select()
				.from(playbook)
				.where(and(eq(playbook.missionType, type), live(playbook)));
			expect(v2).toMatchObject({
				id: v1.id,
				version: 2,
				name: "Landing page, revised",
			});
		});
	});

	it("refuses a new playbook for a type that has one since, and leaves the proposal pending", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const s = await seed(h.tx, h.ns);
			const type = `landing-page-${h.ns}`;
			const draft = {
				playbook: { ...s.fields(type), defaultPresetId: null },
				newPreset: s.preset("Twice"),
				replacesVersion: null,
			};
			const a = await s.insert("playbook", draft);
			const b = await s.insert("playbook", draft);
			expect(
				(await h.call(`/api/proposals/${a}/approve`, { method: "POST" }))
					.status,
			).toBe(200);
			const res = await h.call(`/api/proposals/${b}/approve`, {
				method: "POST",
			});
			expect(res.status).toBe(409);
			expect(errorEnvelope.parse(await res.json()).error.code).toBe("CONFLICT");
			const [row] = await h.tx
				.select({ status: proposal.status })
				.from(proposal)
				.where(eq(proposal.id, b));
			expect(row?.status).toBe("pending");
		});
	});

	it("refuses a payload its kind cannot parse as a broken row", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const s = await seed(h.tx, h.ns);
			const both = await s.insert("playbook", {
				playbook: {
					...s.fields(`x-${h.ns}`),
					defaultPresetId: s.id(),
				},
				newPreset: s.preset("Both"),
				replacesVersion: null,
			});
			const res = await h.call(`/api/proposals/${both}/approve`, {
				method: "POST",
			});
			expect(res.status).toBe(500);
			expect(errorEnvelope.parse(await res.json()).error.code).toBe("INTERNAL");
		});
	});
});
