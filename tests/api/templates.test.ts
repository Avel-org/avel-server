import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { successEnvelope, templateSchema } from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { mission, playbook, rosterPreset } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { fixtureTemplateSource } from "../../src/gateways/template-source";
import { clock, withApi } from "./support";

const list = successEnvelope(templateSchema.array());
const one = successEnvelope(templateSchema);
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * Slugs under a fresh tag, so parallel test files never share a playbook
 * key. withApi picks its ns inside, after the source is built, so the tag is
 * the test's own.
 */
const slugsFor = (tag: string) => ({
	built: `template-built-${tag}`,
	bare: `template-bare-${tag}`,
	broken: `template-broken-${tag}`,
});

const newTag = () => randomUUID().slice(0, 8);

function source(tag: string) {
	const s = slugsFor(tag);
	return fixtureTemplateSource([s.built, s.bare, s.broken], {
		[s.built]: {
			manifest: {
				name: "Built",
				scope: "full-stack",
				startingState: "greenfield",
			},
			headSha: SHA,
		},
		[s.bare]: {
			manifest: { name: "Bare", scope: "audit", startingState: "brownfield" },
			headSha: SHA,
		},
	});
}

/** A playbook and three missions for the built template: two live, one deleted. */
async function seed(tx: Tx, ns: string, tag: string) {
	const s = slugsFor(tag);
	let n = 0xc00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const presetId = id();
	await tx.insert(rosterPreset).values({
		id: presetId,
		name: `Preset ${ns}`,
		cut: "vertical",
		agents: [],
		version: 1,
		...stamp(clock),
	});
	await tx.insert(playbook).values({
		id: id(),
		missionType: s.built,
		name: "Built",
		wavesApplicable: ["A"],
		gates: [],
		deliverable: "pr",
		requiredFields: [],
		defaultPresetId: presetId,
		version: 1,
		...stamp(clock),
	});
	for (const deletedAt of [null, null, clock.now()]) {
		await tx.insert(mission).values({
			id: id(),
			origin: "internal",
			engagementId: null,
			type: s.built,
			brief: {},
			sprintN: 1,
			status: "draft",
			cut: "vertical",
			cutSource: "derived",
			repoUrl: "https://github.com/avel-org/app",
			templateRef: s.built,
			templateVersion: SHA,
			deletedAt,
			...stamp(clock),
		});
	}
	return { ...s, presetId };
}

describe.skipIf(!process.env.DATABASE_URL)("/api/templates", () => {
	afterAll(closeDb);

	it("lists every allowlisted template in order, an unreadable one included", async () => {
		const tag = newTag();
		await withApi(
			async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = await seed(tx, ns, tag);
				const res = await call("/api/templates");
				expect(res.status).toBe(200);
				expect(list.parse(await res.json()).data).toEqual([
					{
						slug: s.built,
						readable: true,
						name: "Built",
						scope: "full-stack",
						startingState: "greenfield",
						latestSha: SHA,
						defaultPresetId: s.presetId,
						missionCount: 2,
					},
					{
						slug: s.bare,
						readable: true,
						name: "Bare",
						scope: "audit",
						startingState: "brownfield",
						latestSha: SHA,
						defaultPresetId: null,
						missionCount: 0,
					},
					{
						slug: s.broken,
						readable: false,
						name: null,
						scope: null,
						startingState: null,
						latestSha: null,
						defaultPresetId: null,
						missionCount: 0,
					},
				]);
			},
			{ templates: source(tag) },
		);
	});

	it("reads one by slug, and answers 404 outside the allowlist", async () => {
		const tag = newTag();
		await withApi(
			async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = await seed(tx, ns, tag);
				const res = await call(`/api/templates/${s.built}`);
				expect(res.status).toBe(200);
				expect(one.parse(await res.json()).data).toMatchObject({
					slug: s.built,
					missionCount: 2,
				});
				expect((await call("/api/templates/template-elsewhere")).status).toBe(
					404,
				);
			},
			{ templates: source(tag) },
		);
	});

	it("needs a session", async () => {
		const tag = newTag();
		await withApi(
			async ({ call }) => {
				expect((await call("/api/templates")).status).toBe(401);
			},
			{ templates: source(tag) },
		);
	});
});
