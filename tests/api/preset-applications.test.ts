import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	pageEnvelope,
	presetApplicationSchema,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	mission,
	rosterPreset,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const applications = pageEnvelope(presetApplicationSchema);

type Call = ApiHarness["call"];

/** Templates, missions and presets under `ns`. */
async function seed(tx: Tx, ns: string) {
	let n = 0x900;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const newMission = async (type: string) => {
		const missionId = id();
		await tx.insert(mission).values({
			id: missionId,
			origin: "internal",
			engagementId: null,
			type,
			brief: {},
			sprintN: 1,
			status: "draft",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			deletedAt: null,
			...stamp(clock),
		});
		return missionId;
	};
	const first = await newMission("full-build");
	const second = await newMission("feature");

	const newTemplate = async (slug: string) => {
		const templateId = id();
		await tx.insert(agentTemplate).values({
			id: templateId,
			slug: `${ns}-${slug}`,
			name: slug,
			kind: "feature",
			roles: ["domain"],
			waveDefaults: ["B"],
			writablePaths: ["src/**"],
			version: 1,
			...stamp(clock),
		});
		return templateId;
	};
	const atlas = await newTemplate("atlas");
	const fenn = await newTemplate("fenn");

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
		{ agent_template_id: fenn, waves: ["C"] },
	]);
	const other = await newPreset([{ agent_template_id: fenn, waves: ["C"] }]);
	const deletedPreset = await newPreset([], clock.now());

	return { first, second, squad, other, deletedPreset, unknown: id(), id };
}

async function apply(
	call: Call,
	missionId: string,
	presetId: string,
	replace = false,
) {
	const res = await call(`/api/missions/${missionId}/roster/apply-preset`, {
		method: "POST",
		body: { presetId, replace },
	});
	expect(res.status).toBe(200);
}

async function list(call: Call, presetId: string, query = "") {
	const res = await call(`/api/presets/${presetId}/applications${query}`);
	expect(res.status).toBe(200);
	return applications.parse(await res.json());
}

describe.skipIf(!process.env.DATABASE_URL)("preset applications", () => {
	afterAll(closeDb);

	it("lists each application newest first, with the version it applied", async () => {
		await withApi(async ({ signIn, call, tx, ns, operator, operatorId }) => {
			await signIn();
			const s = await seed(tx, ns);
			await apply(call, s.first, s.squad);
			const bumped = await call(`/api/presets/${s.squad}`, {
				method: "PATCH",
				body: { name: "Bumped" },
			});
			expect(bumped.status).toBe(200);
			await apply(call, s.second, s.squad);
			await apply(call, s.first, s.squad, true);
			// Another preset on the same mission is not this preset's.
			await apply(call, s.second, s.other, true);

			const { data, meta } = await list(call, s.squad);
			const actor = {
				kind: "operator",
				userId: await operatorId(),
				rosterEntryId: null,
				canonSessionId: null,
				display: operator.login,
				agent: null,
			};
			const at = clock.now().toISOString();
			expect(data).toEqual([
				{
					missionId: s.first,
					mission: { status: "draft", type: "full-build" },
					presetVersion: 3,
					appliedAt: at,
					actor,
					added: 2,
					removed: 2,
				},
				{
					missionId: s.second,
					mission: { status: "draft", type: "feature" },
					presetVersion: 3,
					appliedAt: at,
					actor,
					added: 2,
					removed: 0,
				},
				{
					missionId: s.first,
					mission: { status: "draft", type: "full-build" },
					presetVersion: 2,
					appliedAt: at,
					actor,
					added: 2,
					removed: 0,
				},
			]);
			expect(meta).toEqual({ nextCursor: null, total: 3 });

			const others = await list(call, s.other);
			expect(others.data.map((a) => a.missionId)).toEqual([s.second]);
		});
	});

	it("orders by time before id, and pages with a cursor", async () => {
		await withApi(async ({ signIn, call, tx, ns, operatorId }) => {
			await signIn();
			const s = await seed(tx, ns);
			await apply(call, s.first, s.squad);
			await apply(call, s.second, s.squad);
			// An older row with the highest id: time decides, so it comes last.
			await tx.insert(activityLog).values({
				id: s.id(),
				at: new Date(clock.now().getTime() - 86_400_000),
				actorKind: "operator",
				actorUserId: await operatorId(),
				action: "roster.preset_applied",
				entityType: "mission",
				entityId: s.first,
				missionId: s.first,
				requestId: "older",
				payload: {
					presetId: s.squad,
					presetVersion: 1,
					added: [],
					removed: [],
				},
			});

			const pages: string[][] = [];
			let cursor: string | null = null;
			do {
				const query: string = `?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
				const { data, meta } = await list(call, s.squad, query);
				expect(meta.total).toBe(3);
				pages.push(data.map((a) => `${a.missionId}@${a.presetVersion}`));
				cursor = meta.nextCursor;
			} while (cursor && pages.length < 5);
			expect(pages).toEqual([
				[`${s.second}@2`],
				[`${s.first}@2`],
				[`${s.first}@1`],
			]);
		});
	});

	it("keeps an application whose mission was deleted, with mission null", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await apply(call, s.first, s.squad);
			await apply(call, s.second, s.squad);
			await tx
				.update(mission)
				.set({ deletedAt: clock.now() })
				.where(eq(mission.id, s.first));
			const { data } = await list(call, s.squad);
			expect(data.map((a) => [a.missionId, a.mission])).toEqual([
				[s.second, { status: "draft", type: "feature" }],
				[s.first, null],
			]);
		});
	});

	it("answers an empty page for a preset never applied", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			expect(await list(call, s.other)).toEqual({
				success: true,
				data: [],
				meta: { nextCursor: null, total: 0 },
			});
		});
	});

	it("answers 404 for a missing or deleted preset", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			for (const id of [s.unknown, s.deletedPreset]) {
				const res = await call(`/api/presets/${id}/applications`);
				expect(res.status).toBe(404);
				const { error } = errorEnvelope.parse(await res.json());
				expect(error.code).toBe("NOT_FOUND");
			}
		});
	});

	it("needs a signed-in operator", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const s = await seed(tx, ns);
			const res = await call(`/api/presets/${s.squad}/applications`);
			expect(res.status).toBe(401);
		});
	});
});
