import { afterAll, describe, expect, it } from "vitest";
import {
	deliverable,
	errorEnvelope,
	gate,
	pageEnvelope,
	playbookSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	deliverable as deliverableEnum,
	gate as gateEnum,
	playbook,
	rosterPreset,
} from "../../src/db/schema";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

const playbookList = pageEnvelope(playbookSchema);
const playbookOne = successEnvelope(playbookSchema);

function at(h: number) {
	return new Date(clock.now().getTime() + h * 3_600_000);
}

/**
 * A preset and three playbooks under `ns`: two live, one deleted whose
 * mission type a live one reuses. Mission types carry `ns` because
 * mission_type is unique among live rows across every parallel test file.
 */
async function seedPlaybooks(tx: Tx, ns: string) {
	let n = 0xa00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const stamped = (h: number) => ({ createdAt: at(h), updatedAt: at(h) });

	const presetId = id();
	await tx.insert(rosterPreset).values({
		id: presetId,
		name: `${ns} full build`,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamped(0),
	});

	const newPlaybook = async (
		h: number,
		fields: {
			missionType: string;
			name: string;
			wavesApplicable: Array<"A" | "B" | "C" | "D" | "E">;
			version?: number;
			deletedAt?: Date | null;
		},
	) => {
		const row = {
			id: id(),
			missionType: fields.missionType,
			name: fields.name,
			wavesApplicable: fields.wavesApplicable,
			gates: [
				{ gate: "phase1-close" as const, policy: "mandatory" as const },
				{ gate: "qa" as const, policy: "warn" as const },
			],
			deliverable: "pr" as const,
			requiredFields: ["goal", "repoUrl"],
			defaultPresetId: presetId,
			version: fields.version ?? 1,
			deletedAt: fields.deletedAt ?? null,
			...stamped(h),
		};
		await tx.insert(playbook).values(row);
		return row;
	};

	const fullBuild = `full-build-${ns}`;
	const oldBuild = await newPlaybook(0, {
		missionType: fullBuild,
		name: `${ns} Full build v1`,
		wavesApplicable: ["A", "B"],
		deletedAt: at(1),
	});
	const build = await newPlaybook(1, {
		missionType: fullBuild,
		name: `${ns} Full build v2`,
		wavesApplicable: ["A", "B", "C"],
		version: 2,
	});
	const discovery = await newPlaybook(2, {
		missionType: `discovery-${ns}`,
		name: `${ns} Discovery`,
		wavesApplicable: ["C"],
	});
	return { presetId, oldBuild, build, discovery };
}

describe("playbook contract vocabulary", () => {
	it("matches the pgEnums exactly", () => {
		expect(gate.options).toEqual(gateEnum.enumValues);
		expect(deliverable.options).toEqual(deliverableEnum.enumValues);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/playbooks", () => {
	afterAll(closeDb);

	it("lists live playbooks newest first, with meta.total", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { presetId, build, discovery } = await seedPlaybooks(tx, ns);
			const res = await call(`/api/playbooks?q=${ns}`);
			expect(res.status).toBe(200);
			const body = playbookList.parse(await res.json());
			expect(body.data.map((p) => p.id)).toEqual([discovery.id, build.id]);
			expect(body.meta).toEqual({ nextCursor: null, total: 2 });
			expect(body.data[1]).toEqual({
				id: build.id,
				missionType: `full-build-${ns}`,
				name: `${ns} Full build v2`,
				wavesApplicable: ["A", "B", "C"],
				gates: [
					{ gate: "phase1-close", policy: "mandatory" },
					{ gate: "qa", policy: "warn" },
				],
				deliverable: "pr",
				requiredFields: ["goal", "repoUrl"],
				defaultPresetId: presetId,
				version: 2,
				createdAt: at(1).toISOString(),
				updatedAt: at(1).toISOString(),
			});
		});
	});

	it("filters by name, case-insensitively", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { discovery } = await seedPlaybooks(tx, ns);
			const body = playbookList.parse(
				await (await call(`/api/playbooks?q=${ns}%20DISCO`)).json(),
			);
			expect(body.data.map((p) => p.id)).toEqual([discovery.id]);
			expect(body.meta.total).toBe(1);
		});
	});

	it("pages by cursor, reaching each playbook once", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { build, discovery } = await seedPlaybooks(tx, ns);
			const first = playbookList.parse(
				await (await call(`/api/playbooks?q=${ns}&limit=1`)).json(),
			);
			expect(first.data.map((p) => p.id)).toEqual([discovery.id]);
			expect(first.meta.total).toBe(2);
			const cursor = first.meta.nextCursor;
			expect(cursor).not.toBeNull();
			const second = playbookList.parse(
				await (
					await call(`/api/playbooks?q=${ns}&limit=1&cursor=${cursor}`)
				).json(),
			);
			expect(second.data.map((p) => p.id)).toEqual([build.id]);
			expect(second.meta.nextCursor).toBeNull();
		});
	});

	it("gets the live playbook for a mission type, never a deleted one", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { build, discovery } = await seedPlaybooks(tx, ns);

			const res = await call(`/api/playbooks/by-type/full-build-${ns}`);
			expect(res.status).toBe(200);
			const { data } = playbookOne.parse(await res.json());
			expect(data.id).toBe(build.id);
			expect(data.version).toBe(2);

			const other = await call(`/api/playbooks/by-type/discovery-${ns}`);
			expect(playbookOne.parse(await other.json()).data.id).toBe(discovery.id);
		});
	});

	it("404s a mission type with no live playbook", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const { build } = await seedPlaybooks(tx, ns);
			// Only a deleted playbook ever held this type.
			await tx.insert(playbook).values({
				id: `${ns}-0000-4000-8000-000000000b01`,
				missionType: `retired-${ns}`,
				name: `${ns} Retired`,
				wavesApplicable: ["A"],
				gates: [],
				deliverable: "report",
				requiredFields: [],
				defaultPresetId: build.defaultPresetId,
				version: 1,
				deletedAt: at(3),
				createdAt: at(2),
				updatedAt: at(2),
			});
			for (const type of [`retired-${ns}`, `nothing-${ns}`]) {
				const res = await call(`/api/playbooks/by-type/${type}`);
				expect(res.status).toBe(404);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"NOT_FOUND",
				);
			}
		});
	});

	it("refuses a forged cursor and an out-of-range limit with 400", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			for (const path of [
				"/api/playbooks?cursor=not-a-cursor",
				"/api/playbooks?limit=0",
			]) {
				const res = await call(path);
				expect(res.status).toBe(400);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"VALIDATION_FAILED",
				);
			}
		});
	});

	it("answers 401 without a session", async () => {
		await withApi(async ({ call }) => {
			for (const path of [
				"/api/playbooks",
				"/api/playbooks/by-type/full-build",
			]) {
				const res = await call(path);
				expect(res.status).toBe(401);
			}
		});
	});
});
