import { afterAll, describe, expect, it } from "vitest";
import {
	agentAccess,
	agentRosterEntrySchema,
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
import { clock, withApi } from "./support";

/** A day after the fixed clock, for ordering by created_at. */
const at = (day: number) => new Date(clock.now().getTime() + day * 86_400_000);

const entries = successEnvelope(agentRosterEntrySchema.array());
const accessOne = successEnvelope(agentAccess);

/**
 * One schema agent on three missions (one deleted, and one entry removed),
 * a role skill attached to schema, and a stack skill attached to a mission.
 */
async function seed(tx: Tx, ns: string) {
	let n = 0xd00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const newTemplate = async (deletedAt: Date | null = null) => {
		const templateId = id();
		await tx.insert(agentTemplate).values({
			id: templateId,
			slug: `${ns}-quill-${n}`,
			name: "Quill",
			kind: "horizontal",
			roles: ["schema"],
			waveDefaults: ["A"],
			identityMd: "#",
			depthMd: "",
			writablePaths: ["src/db/**"],
			version: 1,
			deletedAt,
			...stamp(clock),
		});
		return templateId;
	};
	const quill = await newTemplate();
	const gone = await newTemplate(clock.now());

	const sourceId = id();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: `Source ${ns}`,
		kind: "internal",
		...stamp(clock),
	});
	const newSkill = async (slug: string, layer: "role" | "stack") => {
		const skillId = id();
		await tx.insert(skill).values({
			id: skillId,
			slug: `${ns}-${slug}`,
			name: slug,
			description: "When to use it.",
			contentMd: "#",
			layer,
			type: "capability",
			grants: [`db:${slug}`],
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
	const read = await newSkill("read", "role");
	const explain = await newSkill("explain", "stack");
	await tx.insert(roleSkills).values({ role: "schema", skillId: read });

	const newMission = async (
		day: number,
		status: "draft" | "active",
		deletedAt: Date | null = null,
	) => {
		const missionId = id();
		await tx.insert(mission).values({
			id: missionId,
			origin: "internal",
			engagementId: null,
			type: "template-booking",
			brief: {},
			sprintN: day,
			status,
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			deletedAt,
			createdAt: at(day),
			updatedAt: at(day),
		});
		return missionId;
	};
	const older = await newMission(1, "active");
	const newer = await newMission(2, "draft");
	const deleted = await newMission(3, "draft", clock.now());
	await tx.insert(missionSkills).values({
		missionId: newer,
		skillId: explain,
		source: "manual",
	});
	const newEntry = async (
		missionId: string,
		territory: string | null,
		deletedAt: Date | null = null,
	) => {
		const entryId = id();
		await tx.insert(rosterEntry).values({
			id: entryId,
			missionId,
			agentTemplateId: quill,
			active: true,
			waves: ["A"],
			territory,
			grain: "default",
			absorbedBoundaries: [],
			deletedAt,
			...stamp(clock),
		});
		return entryId;
	};
	const onOlder = await newEntry(older, null);
	const onNewerA = await newEntry(newer, "billing");
	const onNewerB = await newEntry(newer, "booking");
	await newEntry(newer, "removed", clock.now());
	await newEntry(deleted, null);
	return { quill, gone, read, older, newer, onOlder, onNewerA, onNewerB };
}

describe.skipIf(!process.env.DATABASE_URL)("agent template reads", () => {
	afterAll(closeDb);

	it("lists live entries on live missions, newest mission first", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(`/api/agent-templates/${s.quill}/roster-entries`);
			expect(res.status).toBe(200);
			const data = entries.parse(await res.json()).data;
			expect(data.map((e) => [e.missionId, e.entryId, e.territory])).toEqual([
				[s.newer, s.onNewerA, "billing"],
				[s.newer, s.onNewerB, "booking"],
				[s.older, s.onOlder, null],
			]);
			expect(data[2]).toMatchObject({
				active: true,
				mission: {
					type: "template-booking",
					status: "active",
					sprintN: 1,
					engagementId: null,
				},
			});
		});
	});

	it("derives access from role skills alone, outside any mission", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			const res = await call(`/api/agent-templates/${s.quill}/access`);
			expect(res.status).toBe(200);
			expect(accessOne.parse(await res.json()).data).toEqual({
				enforced: false,
				rows: [
					{ kind: "repository", mode: "write_held", scope: ["src/db/**"] },
					{
						kind: "grant",
						skillId: s.read,
						skillSlug: `${ns}-read`,
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

	it("answers 404 for a deleted template on both reads", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = await seed(tx, ns);
			for (const path of ["roster-entries", "access"]) {
				const res = await call(`/api/agent-templates/${s.gone}/${path}`);
				expect(res.status).toBe(404);
			}
		});
	});
});
