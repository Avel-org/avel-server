import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	playbookSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	mission,
	playbook,
	rosterPreset,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const playbookOne = successEnvelope(playbookSchema);
const playbookMany = successEnvelope(playbookSchema.array());

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

/** Presets and a mission factory under `ns`. Mission types carry ns: the live-type index is global. */
async function seed(tx: Tx, ns: string) {
	let n = 0xc00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const newPreset = async (
		waves: Array<Array<"A" | "B" | "C" | "D" | "E">>,
		deletedAt: Date | null = null,
	) => {
		const presetId = id();
		await tx.insert(rosterPreset).values({
			id: presetId,
			name: `Preset ${ns}`,
			description: null,
			cut: "vertical",
			agents: waves.map((w) => ({ agent_template_id: id(), waves: w })),
			version: 1,
			deletedAt,
			...stamp(clock),
		});
		return presetId;
	};
	const staffsA = await newPreset([["C"], ["A", "B"]]);
	const staffsB = await newPreset([["B"], ["D"]]);
	const deletedPreset = await newPreset([["A"]], clock.now());

	const newMission = async (
		type: string,
		status: "draft" | "active" | "halted" | "shipped" | "archived",
		deletedAt: Date | null = null,
	) => {
		await tx.insert(mission).values({
			id: id(),
			origin: "internal",
			engagementId: null,
			type,
			brief: {},
			sprintN: 1,
			status,
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			deletedAt,
			...stamp(clock),
		});
	};
	return { id, staffsA, staffsB, deletedPreset, newMission };
}

function body(ns: string, presetId: string) {
	return {
		missionType: `full-build-${ns}`,
		name: "Full build",
		wavesApplicable: ["A", "B", "C"],
		gates: [
			{ gate: "phase1-close", policy: "mandatory" },
			{ gate: "qa", policy: "warn" },
		],
		deliverable: "pr",
		requiredFields: ["goal", "repoUrl"],
		defaultPresetId: presetId,
	};
}

function replacement(presetId: string) {
	return {
		name: "Full build, revised",
		wavesApplicable: ["B", "D"],
		gates: [{ gate: "security", policy: "mandatory" }],
		deliverable: "report",
		requiredFields: ["goal"],
		defaultPresetId: presetId,
	};
}

async function create(call: Call, b: unknown) {
	return call("/api/playbooks", { method: "POST", body: b });
}

async function update(call: Call, missionType: string, b: unknown) {
	return call(`/api/playbooks/by-type/${missionType}`, {
		method: "PUT",
		body: b,
	});
}

async function playbookRows(tx: Tx, missionType: string) {
	return tx
		.select()
		.from(playbook)
		.where(eq(playbook.missionType, missionType));
}

describe.skipIf(!process.env.DATABASE_URL)("playbook writes", () => {
	afterAll(closeDb);

	describe("POST /api/playbooks", () => {
		it("creates version 1, logs the whole playbook, and reads back by type", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows, operatorId }) => {
				await signIn();
				const { staffsA } = await seed(tx, ns);
				const res = await create(call, body(ns, staffsA));
				expect(res.status).toBe(201);
				const { data } = playbookOne.parse(await res.json());
				const { missionType: _, ...fields } = body(ns, staffsA);
				expect(data).toEqual({
					id: expect.any(String),
					missionType: `full-build-${ns}`,
					...fields,
					version: 1,
					createdAt: clock.now().toISOString(),
					updatedAt: clock.now().toISOString(),
				});
				expect(data.id.startsWith(ns)).toBe(true);

				const logs = await logRows(data.id);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					action: "playbook.created",
					entityType: "playbook",
					actorKind: "operator",
					actorUserId: await operatorId(),
					payload: data,
				});

				const got = await call(`/api/playbooks/by-type/full-build-${ns}`);
				expect(playbookOne.parse(await got.json()).data).toEqual(data);
			});
		});

		it("refuses a second live playbook for the type with 409, and allows one where only a deleted one exists", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, id } = await seed(tx, ns);
				expect((await create(call, body(ns, staffsA))).status).toBe(201);
				await expectFailure(
					await create(call, { ...body(ns, staffsA), name: "Again" }),
					409,
					"CONFLICT",
				);
				expect(await playbookRows(tx, `full-build-${ns}`)).toHaveLength(1);

				await tx.insert(playbook).values({
					id: id(),
					missionType: `retired-${ns}`,
					name: "Retired",
					wavesApplicable: ["A"],
					gates: [],
					deliverable: "pr",
					requiredFields: [],
					defaultPresetId: staffsA,
					version: 4,
					deletedAt: clock.now(),
					...stamp(clock),
				});
				const res = await create(call, {
					...body(ns, staffsA),
					missionType: `retired-${ns}`,
				});
				expect(res.status).toBe(201);
				expect(playbookOne.parse(await res.json()).data.version).toBe(1);
			});
		});

		it("refuses malformed bodies with 400 and writes nothing", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA } = await seed(tx, ns);
				const base = body(ns, staffsA);
				const cases: Array<[string, unknown]> = [
					[
						"a gate listed twice",
						{
							...base,
							gates: [
								{ gate: "qa", policy: "warn" },
								{ gate: "qa", policy: "mandatory" },
							],
						},
					],
					[
						"a gate outside the vocabulary",
						{ ...base, gates: [{ gate: "lint", policy: "warn" }] },
					],
					[
						"a skippable policy",
						{ ...base, gates: [{ gate: "qa", policy: "skip" }] },
					],
					["no waves", { ...base, wavesApplicable: [] }],
					["a wave twice", { ...base, wavesApplicable: ["A", "A", "B"] }],
					["waves out of order", { ...base, wavesApplicable: ["B", "A"] }],
					[
						"a required field twice",
						{ ...base, requiredFields: ["goal", "goal"] },
					],
					[
						"a blank required field",
						{ ...base, requiredFields: ["goal", "  "] },
					],
					[
						"a mission type that is not a slug",
						{ ...base, missionType: `Full Build ${ns}` },
					],
					["an unknown key", { ...base, version: 7 }],
				];
				for (const [label, b] of cases) {
					const res = await create(call, b);
					expect(res.status, label).toBe(400);
					expect(errorEnvelope.parse(await res.json()).error.code, label).toBe(
						"VALIDATION_FAILED",
					);
				}
				expect(await playbookRows(tx, `full-build-${ns}`)).toEqual([]);
			});
		});

		it("names the offending gate and wave in the issue path", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA } = await seed(tx, ns);
				const res = await create(call, {
					...body(ns, staffsA),
					wavesApplicable: ["A", "C", "B"],
					gates: [
						{ gate: "qa", policy: "warn" },
						{ gate: "rollback", policy: "warn" },
						{ gate: "qa", policy: "mandatory" },
					],
				});
				const error = await expectFailure(res, 400, "VALIDATION_FAILED");
				const paths = (
					error.details as { body: Array<{ path: unknown[] }> }
				).body.map((i) => i.path);
				expect(paths).toContainEqual(["wavesApplicable", 2]);
				expect(paths).toContainEqual(["gates", 2, "gate"]);
			});
		});

		it("refuses a missing or deleted default preset with preset_not_found", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { deletedPreset, id } = await seed(tx, ns);
				await expectReason(
					await create(call, body(ns, id())),
					"preset_not_found",
				);
				await expectReason(
					await create(call, body(ns, deletedPreset)),
					"preset_not_found",
				);
				expect(await playbookRows(tx, `full-build-${ns}`)).toEqual([]);
			});
		});

		it("refuses a preset with no agent in the earliest declared wave", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsB } = await seed(tx, ns);
				// staffsB has agents in B and D only.
				await expectReason(
					await create(call, body(ns, staffsB)),
					"preset_misses_first_wave",
				);
				expect(await playbookRows(tx, `full-build-${ns}`)).toEqual([]);
				// With B the earliest declared wave, the same preset qualifies.
				const res = await create(call, {
					...body(ns, staffsB),
					wavesApplicable: ["B", "C"],
				});
				expect(res.status).toBe(201);
			});
		});
	});

	describe("PUT /api/playbooks/by-type/:missionType", () => {
		it("replaces every field, bumps the version, keeps id, type and createdAt, and logs the whole playbook", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const { staffsA, staffsB } = await seed(tx, ns);
				const created = playbookOne.parse(
					await (await create(call, body(ns, staffsA))).json(),
				).data;
				const res = await update(
					call,
					`full-build-${ns}`,
					replacement(staffsB),
				);
				expect(res.status).toBe(200);
				const { data } = playbookOne.parse(await res.json());
				expect(data).toEqual({
					id: created.id,
					missionType: `full-build-${ns}`,
					...replacement(staffsB),
					version: 2,
					createdAt: created.createdAt,
					updatedAt: clock.now().toISOString(),
				});
				const logs = await logRows(created.id);
				expect(logs.map((l) => l.action)).toEqual([
					"playbook.created",
					"playbook.updated",
				]);
				expect(logs[1]?.payload).toEqual(data);
			});
		});

		it("refuses missionType in the body, and any malformed field, with 400", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA } = await seed(tx, ns);
				await create(call, body(ns, staffsA));
				for (const b of [
					{ ...replacement(staffsA), missionType: `other-${ns}` },
					{
						...replacement(staffsA),
						gates: [
							{ gate: "security", policy: "warn" },
							{ gate: "security", policy: "warn" },
						],
					},
					{ ...replacement(staffsA), wavesApplicable: ["D", "B"] },
					{ name: "Only a name" },
				]) {
					await expectFailure(
						await update(call, `full-build-${ns}`, b),
						400,
						"VALIDATION_FAILED",
					);
				}
				const [row] = await playbookRows(tx, `full-build-${ns}`);
				expect(row?.version).toBe(1);
			});
		});

		it("404s a type with no live playbook", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, id } = await seed(tx, ns);
				await tx.insert(playbook).values({
					id: id(),
					missionType: `retired-${ns}`,
					name: "Retired",
					wavesApplicable: ["A"],
					gates: [],
					deliverable: "pr",
					requiredFields: [],
					defaultPresetId: staffsA,
					version: 1,
					deletedAt: clock.now(),
					...stamp(clock),
				});
				for (const type of [`retired-${ns}`, `nothing-${ns}`]) {
					await expectFailure(
						await update(call, type, replacement(staffsA)),
						404,
						"NOT_FOUND",
					);
				}
			});
		});

		it("is refused with playbook_in_use while a live mission of the type is active or halted", async () => {
			for (const status of ["active", "halted"] as const) {
				await withApi(async ({ signIn, call, tx, ns }) => {
					await signIn();
					const { staffsA, newMission } = await seed(tx, ns);
					await create(call, body(ns, staffsA));
					await newMission(`full-build-${ns}`, status);
					await expectReason(
						await update(call, `full-build-${ns}`, replacement(staffsA)),
						"playbook_in_use",
					);
					const [row] = await playbookRows(tx, `full-build-${ns}`);
					expect(row?.version, status).toBe(1);
				});
			}
		});

		it("is allowed beside draft, shipped, archived, deleted and other-type missions", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, newMission } = await seed(tx, ns);
				await create(call, body(ns, staffsA));
				const type = `full-build-${ns}`;
				await newMission(type, "draft");
				await newMission(type, "shipped");
				await newMission(type, "archived");
				await newMission(type, "active", clock.now());
				await newMission(`discovery-${ns}`, "active");
				const res = await update(call, type, replacement(staffsA));
				expect(res.status).toBe(200);
			});
		});

		it("checks in order: not found, then in use, then the preset", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = await seed(tx, ns);
				// No playbook, but a running mission of the type: 404 comes first.
				await s.newMission(`ghost-${ns}`, "active");
				await expectFailure(
					await update(call, `ghost-${ns}`, replacement(s.staffsA)),
					404,
					"NOT_FOUND",
				);
				// In use and a missing preset: in use comes first.
				await create(call, body(ns, s.staffsA));
				await s.newMission(`full-build-${ns}`, "active");
				await expectReason(
					await update(call, `full-build-${ns}`, replacement(s.id())),
					"playbook_in_use",
				);
			});
		});

		it("refuses a missing preset and one that misses the earliest wave", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, staffsB, deletedPreset } = await seed(tx, ns);
				await create(call, body(ns, staffsA));
				const type = `full-build-${ns}`;
				await expectReason(
					await update(call, type, replacement(deletedPreset)),
					"preset_not_found",
				);
				await expectReason(
					await update(call, type, {
						...replacement(staffsB),
						wavesApplicable: ["A", "B"],
					}),
					"preset_misses_first_wave",
				);
				const [row] = await playbookRows(tx, type);
				expect(row?.version).toBe(1);
			});
		});
	});

	describe("GET /api/playbooks/by-type/:missionType/versions", () => {
		/** A playbook written straight to the table, as the seed does: no activity rows. */
		async function unlogged(tx: Tx, ns: string, presetId: string, id: string) {
			await tx.insert(playbook).values({
				id,
				missionType: `seeded-${ns}`,
				name: "Seeded",
				wavesApplicable: ["A", "B"],
				gates: [{ gate: "qa", policy: "mandatory" }],
				deliverable: "pr",
				requiredFields: ["goal"],
				defaultPresetId: presetId,
				version: 4,
				deletedAt: null,
				...stamp(clock),
			});
		}

		it("returns the current row when the playbook has no logged writes", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, id } = await seed(tx, ns);
				await unlogged(tx, ns, staffsA, id());
				const current = playbookOne.parse(
					await (await call(`/api/playbooks/by-type/seeded-${ns}`)).json(),
				).data;
				const { data } = playbookMany.parse(
					await (
						await call(`/api/playbooks/by-type/seeded-${ns}/versions`)
					).json(),
				);
				expect(data).toEqual([current]);
				expect(data[0]?.version).toBe(4);
			});
		});

		it("returns only logged writes once there are any, with no synthesized row", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, id } = await seed(tx, ns);
				await unlogged(tx, ns, staffsA, id());
				const v5 = playbookOne.parse(
					await (
						await update(call, `seeded-${ns}`, replacement(staffsA))
					).json(),
				).data;
				expect(v5.version).toBe(5);
				const { data } = playbookMany.parse(
					await (
						await call(`/api/playbooks/by-type/seeded-${ns}/versions`)
					).json(),
				);
				expect(data).toEqual([v5]);
			});
		});

		it("returns every written version, newest first, each the whole playbook", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA, staffsB } = await seed(tx, ns);
				const type = `full-build-${ns}`;
				const v1 = playbookOne.parse(
					await (await create(call, body(ns, staffsA))).json(),
				).data;
				const v2 = playbookOne.parse(
					await (await update(call, type, replacement(staffsB))).json(),
				).data;
				const v3 = playbookOne.parse(
					await (
						await update(call, type, { ...replacement(staffsA), name: "Third" })
					).json(),
				).data;

				const res = await call(`/api/playbooks/by-type/${type}/versions`);
				expect(res.status).toBe(200);
				const { data } = playbookMany.parse(await res.json());
				expect(data).toEqual([v3, v2, v1]);
				expect(data.map((p) => p.version)).toEqual([3, 2, 1]);
				expect(data[2]?.name).toBe("Full build");
				expect(data[1]?.deliverable).toBe("report");
			});
		});

		it("reads only this playbook's rows, not a deleted predecessor's or another type's", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const { staffsA } = await seed(tx, ns);
				const type = `full-build-${ns}`;
				const first = playbookOne.parse(
					await (await create(call, body(ns, staffsA))).json(),
				).data;
				await create(call, {
					...body(ns, staffsA),
					missionType: `other-${ns}`,
				});
				// Retire the first, then create the type again.
				await tx
					.update(playbook)
					.set({ deletedAt: clock.now() })
					.where(eq(playbook.id, first.id));
				const second = playbookOne.parse(
					await (await create(call, body(ns, staffsA))).json(),
				).data;
				const { data } = playbookMany.parse(
					await (await call(`/api/playbooks/by-type/${type}/versions`)).json(),
				);
				expect(data).toEqual([second]);
				const logged = await tx
					.select({ id: activityLog.id })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.entityType, "playbook"),
							eq(activityLog.entityId, first.id),
						),
					);
				expect(logged).toHaveLength(1);
			});
		});

		it("404s a type with no live playbook", async () => {
			await withApi(async ({ signIn, call, ns }) => {
				await signIn();
				await expectFailure(
					await call(`/api/playbooks/by-type/nothing-${ns}/versions`),
					404,
					"NOT_FOUND",
				);
			});
		});
	});

	it("answers 401 to writes without a session", async () => {
		await withApi(async ({ call, ns }) => {
			expect((await create(call, {})).status).toBe(401);
			expect((await update(call, `full-build-${ns}`, {})).status).toBe(401);
			expect(
				(await call(`/api/playbooks/by-type/full-build-${ns}/versions`)).status,
			).toBe(401);
		});
	});
});
