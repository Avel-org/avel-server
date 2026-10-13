import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	presetSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { activityLog, agentTemplate, rosterPreset } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const presetOne = successEnvelope(presetSchema);

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

/** Templates and presets under `ns`. */
async function seed(tx: Tx, ns: string) {
	let n = 0x900;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
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

	const newPreset = async (deletedAt: Date | null = null) => {
		const presetId = id();
		await tx.insert(rosterPreset).values({
			id: presetId,
			name: `Preset ${ns}`,
			description: "Seeded",
			cut: "vertical",
			agents: [{ agent_template_id: fenn, waves: ["C"] }],
			version: 1,
			deletedAt,
			...stamp(clock),
		});
		return presetId;
	};
	const saved = await newPreset();
	const deletedPreset = await newPreset(clock.now());

	return { atlas, fenn, canon, gone, saved, deletedPreset, unknown: id() };
}

function agent(agentTemplateId: string, overrides: object = {}) {
	return {
		agentTemplateId,
		waves: ["B"],
		territory: null,
		writablePaths: null,
		estimatedTokens: null,
		...overrides,
	};
}

async function create(call: Call, body: object) {
	return call("/api/presets", { method: "POST", body });
}

async function update(call: Call, id: string, body: object) {
	return call(`/api/presets/${id}`, { method: "PATCH", body });
}

async function presetLogs(tx: Tx) {
	return tx
		.select()
		.from(activityLog)
		.where(eq(activityLog.entityType, "roster_preset"));
}

describe.skipIf(!process.env.DATABASE_URL)("preset create", () => {
	afterAll(closeDb);

	it("saves a squad at version 1, stores nulls as absent keys, and logs it", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows, operatorId }) => {
			await signIn();
			const s = await seed(tx, ns);
			const agents = [
				agent(s.atlas),
				agent(s.atlas, {
					waves: ["B", "C"],
					territory: "payments",
					writablePaths: ["src/payments/**"],
					estimatedTokens: 80_000,
				}),
				agent(s.fenn, { waves: ["C"] }),
			];
			const res = await create(call, {
				name: "  Full build  ",
				cut: "horizontal",
				agents,
			});
			expect(res.status).toBe(201);
			const preset = presetOne.parse(await res.json()).data;
			expect(preset).toEqual({
				id: expect.stringMatching(new RegExp(`^${ns}-`)),
				name: "Full build",
				description: null,
				cut: "horizontal",
				agents,
				version: 1,
				createdAt: clock.now().toISOString(),
				updatedAt: clock.now().toISOString(),
			});

			const [stored] = await tx
				.select()
				.from(rosterPreset)
				.where(eq(rosterPreset.id, preset.id));
			expect(stored?.agents).toEqual([
				{ agent_template_id: s.atlas, waves: ["B"] },
				{
					agent_template_id: s.atlas,
					waves: ["B", "C"],
					territory: "payments",
					writable_paths: ["src/payments/**"],
					estimated_tokens: 80_000,
				},
				{ agent_template_id: s.fenn, waves: ["C"] },
			]);

			const read = await call(`/api/presets/${preset.id}`);
			expect(presetOne.parse(await read.json()).data).toEqual(preset);

			const logs = await logRows(preset.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				action: "preset.created",
				entityType: "roster_preset",
				actorKind: "operator",
				actorUserId: await operatorId(),
				missionId: null,
				engagementId: null,
				payload: { name: "Full build", cut: "horizontal", agentCount: 3 },
			});
		});
	});

	it("refuses templates that are missing, deleted or Firm, and writes nothing", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const base = { name: "Squad", cut: "vertical" };
			await expectReason(
				await create(call, { ...base, agents: [agent(s.unknown)] }),
				"agent_template_not_found",
			);
			await expectReason(
				await create(call, {
					...base,
					agents: [agent(s.atlas), agent(s.gone)],
				}),
				"agent_template_not_found",
			);
			await expectReason(
				await create(call, {
					...base,
					agents: [agent(s.atlas), agent(s.canon)],
				}),
				"template_not_rosterable",
			);
			expect(
				await tx
					.select()
					.from(rosterPreset)
					.where(eq(rosterPreset.name, "Squad")),
			).toEqual([]);
			expect(await presetLogs(tx)).toEqual([]);
		});
	});

	it("refuses one template twice for the same territory, a null territory included", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const base = { name: "Squad", cut: "vertical" };
			await expectFailure(
				await create(call, {
					...base,
					agents: [agent(s.fenn), agent(s.fenn, { waves: ["D"] })],
				}),
				409,
				"CONFLICT",
			);
			await expectFailure(
				await create(call, {
					...base,
					agents: [
						agent(s.fenn, { territory: "auth" }),
						agent(s.fenn, { territory: "auth" }),
					],
				}),
				409,
				"CONFLICT",
			);
			expect(await presetLogs(tx)).toEqual([]);
		});
	});

	it("refuses bodies that break the shape or the roster entry's field rules", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const base = { name: "Squad", cut: "vertical", agents: [agent(s.fenn)] };
			const bad: object[] = [
				{ cut: "vertical", agents: [] },
				{ name: "Squad", agents: [] },
				{ ...base, name: "   " },
				{ ...base, cut: "diagonal" },
				{ ...base, description: "" },
				{ ...base, version: 7 },
				{ ...base, agents: [agent(s.fenn, { waves: [] })] },
				{ ...base, agents: [agent(s.fenn, { territory: "  " })] },
				{ ...base, agents: [agent(s.fenn, { writablePaths: [] })] },
				{ ...base, agents: [agent(s.fenn, { writablePaths: [" "] })] },
				{ ...base, agents: [agent(s.fenn, { estimatedTokens: 0 })] },
				{ ...base, agents: [agent(s.fenn, { extra: true })] },
				{ ...base, agents: [{ agentTemplateId: s.fenn, waves: ["B"] }] },
			];
			for (const body of bad) {
				await expectFailure(await create(call, body), 400, "VALIDATION_FAILED");
			}
			expect(await presetLogs(tx)).toEqual([]);
		});
	});

	it("needs a signed-in operator", async () => {
		await withApi(async ({ call }) => {
			await expectFailure(
				await create(call, { name: "Squad", cut: "vertical", agents: [] }),
				401,
				"UNAUTHENTICATED",
			);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("preset update", () => {
	afterAll(closeDb);

	it("changes only what was sent and adds 1 to version on every update", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns);
			const renamed = presetOne.parse(
				await (await update(call, s.saved, { name: "Renamed" })).json(),
			).data;
			expect(renamed).toMatchObject({
				id: s.saved,
				name: "Renamed",
				description: "Seeded",
				cut: "vertical",
				agents: [agent(s.fenn, { waves: ["C"] })],
				version: 2,
			});

			const agents = [agent(s.atlas, { territory: "web" })];
			const res = await update(call, s.saved, {
				description: null,
				cut: "horizontal",
				agents,
			});
			expect(res.status).toBe(200);
			const replaced = presetOne.parse(await res.json()).data;
			expect(replaced).toMatchObject({
				name: "Renamed",
				description: null,
				cut: "horizontal",
				agents,
				version: 3,
			});
			const read = await call(`/api/presets/${s.saved}`);
			expect(presetOne.parse(await read.json()).data).toEqual(replaced);

			const logs = await logRows(s.saved);
			expect(logs.map((l) => [l.action, l.entityType, l.payload])).toEqual([
				["preset.updated", "roster_preset", { fields: ["name"], version: 2 }],
				[
					"preset.updated",
					"roster_preset",
					{ fields: ["agents", "cut", "description"], version: 3 },
				],
			]);
		});
	});

	it("answers 404 for a missing or deleted preset, before looking at the agents", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await expectFailure(
				await update(call, s.unknown, { name: "X" }),
				404,
				"NOT_FOUND",
			);
			await expectFailure(
				await update(call, s.deletedPreset, { name: "X" }),
				404,
				"NOT_FOUND",
			);
			await expectFailure(
				await update(call, s.deletedPreset, { agents: [agent(s.canon)] }),
				404,
				"NOT_FOUND",
			);
			expect(await presetLogs(tx)).toEqual([]);
		});
	});

	it("refuses bad agents as create does, and leaves the version alone", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await expectReason(
				await update(call, s.saved, { agents: [agent(s.gone)] }),
				"agent_template_not_found",
			);
			await expectReason(
				await update(call, s.saved, { agents: [agent(s.canon)] }),
				"template_not_rosterable",
			);
			await expectFailure(
				await update(call, s.saved, {
					agents: [agent(s.atlas), agent(s.atlas)],
				}),
				409,
				"CONFLICT",
			);
			await expectFailure(
				await update(call, s.saved, {}),
				400,
				"VALIDATION_FAILED",
			);
			await expectFailure(
				await update(call, s.saved, { version: 9 }),
				400,
				"VALIDATION_FAILED",
			);
			const [row] = await tx
				.select()
				.from(rosterPreset)
				.where(eq(rosterPreset.id, s.saved));
			expect(row).toMatchObject({ name: `Preset ${ns}`, version: 1 });
			expect(await presetLogs(tx)).toEqual([]);
		});
	});
});
