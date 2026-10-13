import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	agentAccess,
	errorEnvelope,
	rosterEntrySchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	agentTemplate,
	mission,
	missionSkills,
	roleSkills,
	rosterEntry,
	skill,
	skillSource,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, withApi } from "./support";

const entryOne = successEnvelope(rosterEntrySchema);
const roster = successEnvelope(rosterEntrySchema.array());
const accessOne = successEnvelope(agentAccess);

type Call = ApiHarness["call"];

/** A draft and an active mission, each with one schema agent, and three capability skills. */
async function seed(tx: Tx, ns: string) {
	let n = 0xb00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const templateId = id();
	await tx.insert(agentTemplate).values({
		id: templateId,
		slug: `${ns}-quill`,
		name: "Quill",
		kind: "horizontal",
		roles: ["schema"],
		waveDefaults: ["A"],
		writablePaths: ["src/db/**"],
		version: 1,
		...stamp(clock),
	});
	const sourceId = id();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: `Source ${ns}`,
		kind: "internal",
		...stamp(clock),
	});
	const newSkill = async (
		slug: string,
		layer: "role" | "stack",
		grants: string[],
	) => {
		const skillId = id();
		await tx.insert(skill).values({
			id: skillId,
			slug: `${ns}-${slug}`,
			name: slug,
			description: "When to use it.",
			contentMd: "#",
			layer,
			type: "capability",
			grants,
			ioShape: { reads: "small", returns: "small" },
			recommendedFor: ["schema"],
			sourceId,
			contentSha256: "c".repeat(64),
			status: "approved",
			version: 1,
			...stamp(clock),
		});
		return skillId;
	};
	const migrate = await newSkill("migrate", "role", ["db:migrate", "db:read"]);
	const explain = await newSkill("explain", "stack", ["db:explain"]);
	// Recommended for schema but attached to no role: the agent never gets it.
	const unattached = await newSkill("unattached", "role", ["db:vacuum"]);
	await tx.insert(roleSkills).values({ role: "schema", skillId: migrate });

	const newMission = async (status: "draft" | "active") => {
		const missionId = id();
		await tx.insert(mission).values({
			id: missionId,
			origin: "internal",
			engagementId: null,
			type: "template-booking",
			brief: {},
			sprintN: 1,
			status,
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			...stamp(clock),
		});
		const entryId = id();
		await tx.insert(rosterEntry).values({
			id: entryId,
			missionId,
			agentTemplateId: templateId,
			active: true,
			waves: ["A"],
			grain: "default",
			absorbedBoundaries: [],
			...stamp(clock),
		});
		return { missionId, entryId };
	};
	const draft = await newMission("draft");
	const active = await newMission("active");
	return { migrate, explain, unattached, draft, active };
}

function patch(
	call: Call,
	at: { missionId: string; entryId: string },
	body: object,
) {
	return call(`/api/missions/${at.missionId}/roster/${at.entryId}`, {
		method: "PATCH",
		body,
	});
}

async function expectInvalid(res: Response, paths: unknown[]) {
	expect(res.status).toBe(422);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("PRECONDITION_FAILED");
	expect(error.details).toMatchObject({ reason: "access_override_invalid" });
	const issues = (error.details as { issues: { path: unknown[] }[] }).issues;
	expect(issues.map((i) => i.path)).toEqual(paths);
}

async function stored(tx: Tx, entryId: string) {
	const [row] = await tx
		.select({ accessOverrides: rosterEntry.accessOverrides })
		.from(rosterEntry)
		.where(eq(rosterEntry.id, entryId));
	return row?.accessOverrides;
}

describe.skipIf(!process.env.DATABASE_URL)("roster access overrides", () => {
	afterAll(closeDb);

	it("starts with none on the wire", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(`/api/missions/${s.draft.missionId}/roster`);
			const [entry] = roster.parse(await res.json()).data;
			expect(entry?.accessOverrides).toBeNull();
		});
	});

	it("stores overrides that narrow, snake_case in the row, camelCase on the wire", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const s = await seed(tx, ns);
			const overrides = [
				{ skillId: s.migrate, grant: "db:migrate", mode: "none" },
				{ skillId: s.migrate, grant: "db:read", mode: "read" },
			];
			const res = await patch(call, s.draft, { accessOverrides: overrides });
			expect(res.status).toBe(200);
			const entry = entryOne.parse(await res.json()).data;
			expect(entry.accessOverrides).toEqual(overrides);
			expect(await stored(tx, s.draft.entryId)).toEqual([
				{ skill_id: s.migrate, grant: "db:migrate", mode: "none" },
				{ skill_id: s.migrate, grant: "db:read", mode: "read" },
			]);
			const logs = await logRows(s.draft.entryId);
			expect(logs.at(-1)?.payload).toEqual({ fields: ["accessOverrides"] });
		});
	});

	it("clears on null and on an empty list", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const one = [{ skillId: s.migrate, grant: "db:migrate", mode: "none" }];
			for (const cleared of [null, []]) {
				await patch(call, s.draft, { accessOverrides: one });
				const res = await patch(call, s.draft, { accessOverrides: cleared });
				expect(
					entryOne.parse(await res.json()).data.accessOverrides,
				).toBeNull();
				expect(await stored(tx, s.draft.entryId)).toBeNull();
			}
		});
	});

	it("leaves overrides alone when a request does not name them", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const one = [{ skillId: s.migrate, grant: "db:migrate", mode: "none" }];
			await patch(call, s.draft, { accessOverrides: one });
			const res = await patch(call, s.draft, { territory: "billing" });
			expect(entryOne.parse(await res.json()).data.accessOverrides).toEqual(
				one,
			);
		});
	});

	it("refuses a row the agent does not have, until its stack skill is attached", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const body = {
				accessOverrides: [
					{ skillId: s.explain, grant: "db:explain", mode: "none" },
				],
			};
			await expectInvalid(await patch(call, s.draft, body), [[0]]);
			expect(await stored(tx, s.draft.entryId)).toBeNull();
			await tx.insert(missionSkills).values({
				missionId: s.draft.missionId,
				skillId: s.explain,
				source: "manual",
			});
			expect((await patch(call, s.draft, body)).status).toBe(200);
		});
	});

	it("refuses a row named twice and a grant the skill does not list", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await patch(call, s.draft, {
				accessOverrides: [
					{ skillId: s.migrate, grant: "db:migrate", mode: "none" },
					{ skillId: s.migrate, grant: "db:migrate", mode: "read" },
					{ skillId: s.migrate, grant: "db:drop", mode: "none" },
				],
			});
			await expectInvalid(res, [[1], [2]]);
		});
	});

	it("refuses a role skill recommended for the role but not attached to it", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await patch(call, s.draft, {
				accessOverrides: [
					{ skillId: s.unattached, grant: "db:vacuum", mode: "none" },
				],
			});
			await expectInvalid(res, [[0]]);
		});
	});

	it("refuses a mode above read as a body problem", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await patch(call, s.draft, {
				accessOverrides: [
					{ skillId: s.migrate, grant: "db:read", mode: "write_held" },
				],
			});
			expect(res.status).toBe(400);
			const { error } = errorEnvelope.parse(await res.json());
			expect(error.code).toBe("VALIDATION_FAILED");
		});
	});

	it("refuses any change once the mission has left draft", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await patch(call, s.active, {
				accessOverrides: [
					{ skillId: s.migrate, grant: "db:migrate", mode: "none" },
				],
			});
			expect(res.status).toBe(422);
			const { error } = errorEnvelope.parse(await res.json());
			expect(error.details).toEqual({ reason: "mission_not_editable" });
		});
	});

	it("answers the entry's access, with its overrides applied", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await patch(call, s.draft, {
				accessOverrides: [
					{ skillId: s.migrate, grant: "db:migrate", mode: "none" },
				],
			});
			const res = await call(
				`/api/missions/${s.draft.missionId}/roster/${s.draft.entryId}/access`,
			);
			expect(res.status).toBe(200);
			const access = accessOne.parse(await res.json()).data;
			expect(access).toEqual({
				enforced: false,
				rows: [
					{ kind: "repository", mode: "write_held", scope: ["src/db/**"] },
					{
						kind: "grant",
						skillId: s.migrate,
						skillSlug: `${ns}-migrate`,
						grant: "db:migrate",
						system: "db",
						derivedMode: "write_held",
						mode: "none",
					},
					{
						kind: "grant",
						skillId: s.migrate,
						skillSlug: `${ns}-migrate`,
						grant: "db:read",
						system: "db",
						derivedMode: "read",
						mode: "read",
					},
					{ kind: "delivery", mode: "send_after_approval" },
				],
				staleOverrides: [],
			});
		});
	});

	it("shows an override whose skill left the mission as stale", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			await tx.insert(missionSkills).values({
				missionId: s.draft.missionId,
				skillId: s.explain,
				source: "manual",
			});
			const override = {
				skillId: s.explain,
				grant: "db:explain",
				mode: "none",
			};
			await patch(call, s.draft, { accessOverrides: [override] });
			await call(`/api/missions/${s.draft.missionId}/skills/${s.explain}`, {
				method: "DELETE",
			});
			const res = await call(
				`/api/missions/${s.draft.missionId}/roster/${s.draft.entryId}/access`,
			);
			const access = accessOne.parse(await res.json()).data;
			expect(access.staleOverrides).toEqual([override]);
			expect(
				access.rows.some((r) => r.kind === "grant" && r.skillId === s.explain),
			).toBe(false);
		});
	});

	it("answers 404 for an entry on another mission", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(
				`/api/missions/${s.active.missionId}/roster/${s.draft.entryId}/access`,
			);
			expect(res.status).toBe(404);
		});
	});
});
