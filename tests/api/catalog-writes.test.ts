import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	removedSchema,
	skillSchema,
	skillSourceSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { skill, skillSource } from "../../src/db/schema";
import { skillContentSha256 } from "../../src/lib/skill-hash";
import { type ApiHarness, clock, withApi } from "./support";

const sourceOne = successEnvelope(skillSourceSchema);
const skillOne = successEnvelope(skillSchema);
const removed = successEnvelope(removedSchema);

type Call = ApiHarness["call"];

async function newSource(call: Call, name = "Internal") {
	const res = await call("/api/skill-sources", {
		method: "POST",
		body: { name, kind: "internal" },
	});
	expect(res.status).toBe(201);
	return sourceOne.parse(await res.json()).data;
}

function knowledgeBody(ns: string, sourceId: string, slug = "keyset") {
	return {
		slug: `${ns}-${slug}`,
		name: "Keyset pagination",
		description: "Use when a list pages.",
		contentMd: "# Keyset\n",
		layer: "stack",
		type: "knowledge",
		recommendedFor: ["api-surface"],
		sourceId,
	};
}

async function newSkill(call: Call, body: object) {
	const res = await call("/api/skills", { method: "POST", body });
	expect(res.status).toBe(201);
	return skillOne.parse(await res.json()).data;
}

async function expectFailure(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe(code);
	return error;
}

describe.skipIf(!process.env.DATABASE_URL)("skill source writes", () => {
	afterAll(closeDb);

	it("creates, updates and logs a source", async () => {
		await withApi(async ({ signIn, call, logRows }) => {
			await signIn();
			const created = await call("/api/skill-sources", {
				method: "POST",
				body: {
					name: "  Vendor  ",
					kind: "vendor",
					url: "https://example.com",
					license: "MIT",
				},
			});
			expect(created.status).toBe(201);
			const source = sourceOne.parse(await created.json()).data;
			expect(source).toMatchObject({
				name: "Vendor",
				kind: "vendor",
				url: "https://example.com",
				license: "MIT",
				skillCount: 0,
				createdAt: clock.now().toISOString(),
			});

			const updated = await call(`/api/skill-sources/${source.id}`, {
				method: "PATCH",
				body: { license: null, kind: "community" },
			});
			expect(updated.status).toBe(200);
			expect(sourceOne.parse(await updated.json()).data).toMatchObject({
				kind: "community",
				license: null,
				url: "https://example.com",
			});

			const logs = await logRows(source.id);
			expect(logs.map((l) => l.action)).toEqual([
				"skill_source.created",
				"skill_source.updated",
			]);
			expect(logs[1]?.payload).toEqual({
				changes: { license: null, kind: "community" },
			});
		});
	});

	it("refuses an empty update, a bad url and an unknown kind with 400", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			const source = await newSource(call);
			for (const [method, path, body] of [
				["PATCH", `/api/skill-sources/${source.id}`, {}],
				[
					"POST",
					"/api/skill-sources",
					{ name: "X", kind: "internal", url: "nope" },
				],
				["POST", "/api/skill-sources", { name: "X", kind: "paid" }],
			] as const) {
				await expectFailure(
					await call(path, { method, body }),
					400,
					"VALIDATION_FAILED",
				);
			}
		});
	});

	it("removes a source with no live skills, and refuses one with them", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const used = await newSource(call, "Used");
			await newSkill(call, knowledgeBody(ns, used.id));
			const refused = await expectFailure(
				await call(`/api/skill-sources/${used.id}`, { method: "DELETE" }),
				422,
				"PRECONDITION_FAILED",
			);
			expect(refused.details).toEqual({ reason: "skill_source_in_use" });
			const [still] = await tx
				.select()
				.from(skillSource)
				.where(eq(skillSource.id, used.id));
			expect(still?.deletedAt).toBeNull();

			const unused = await newSource(call, "Unused");
			const res = await call(`/api/skill-sources/${unused.id}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(200);
			expect(removed.parse(await res.json()).data).toEqual({ id: unused.id });
			expect((await call(`/api/skill-sources/${unused.id}`)).status).toBe(404);
			expect(
				(await call(`/api/skill-sources/${unused.id}`, { method: "DELETE" }))
					.status,
			).toBe(404);
			expect((await logRows(unused.id)).map((l) => l.action)).toEqual([
				"skill_source.created",
				"skill_source.deleted",
			]);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("skill create", () => {
	afterAll(closeDb);

	it("creates a draft at version 1 with the server's hash, and logs it", async () => {
		await withApi(async ({ signIn, call, ns, logRows }) => {
			await signIn();
			const source = await newSource(call);
			const created = await newSkill(call, knowledgeBody(ns, source.id));
			expect(created).toMatchObject({
				slug: `${ns}-keyset`,
				type: "knowledge",
				grants: null,
				ioShape: null,
				avelEnhancementMd: null,
				status: "draft",
				version: 1,
				reviewedBy: null,
				reviewedAt: null,
				source: { id: source.id, name: "Internal", kind: "internal" },
				contentSha256: skillContentSha256({
					description: "Use when a list pages.",
					contentMd: "# Keyset\n",
					avelEnhancementMd: null,
					grants: null,
					ioShape: null,
					type: "knowledge",
					layer: "stack",
				}),
			});
			const logs = await logRows(created.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				action: "skill.created",
				entityType: "skill",
				actorKind: "operator",
			});
		});
	});

	it("creates a capability with its grants and ioShape", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const source = await newSource(call);
			const created = await newSkill(call, {
				...knowledgeBody(ns, source.id, "search"),
				type: "capability",
				grants: ["read:source"],
				ioShape: { reads: "large", returns: "small" },
			});
			expect(created).toMatchObject({
				type: "capability",
				grants: ["read:source"],
				ioShape: { reads: "large", returns: "small" },
			});
		});
	});

	it("refuses bodies that break the capability rule or the slug shape with 400", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const source = await newSource(call);
			const base = knowledgeBody(ns, source.id);
			for (const body of [
				{ ...base, type: "capability" },
				{ ...base, grants: ["read:source"] },
				{ ...base, slug: "Not A Slug" },
				{ ...base, recommendedFor: [] },
				{ ...base, status: "approved" },
			]) {
				await expectFailure(
					await call("/api/skills", { method: "POST", body }),
					400,
					"VALIDATION_FAILED",
				);
			}
		});
	});

	it("refuses a missing or deleted source with 422 and a taken slug with 409", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const source = await newSource(call);
			const gone = await newSource(call, "Gone");
			await call(`/api/skill-sources/${gone.id}`, { method: "DELETE" });
			for (const sourceId of [gone.id, `${ns}-0000-4000-8000-00000000ffff`]) {
				const error = await expectFailure(
					await call("/api/skills", {
						method: "POST",
						body: knowledgeBody(ns, sourceId),
					}),
					422,
					"PRECONDITION_FAILED",
				);
				expect(error.details).toEqual({ reason: "skill_source_not_found" });
			}
			await newSkill(call, knowledgeBody(ns, source.id));
			await expectFailure(
				await call("/api/skills", {
					method: "POST",
					body: knowledgeBody(ns, source.id),
				}),
				409,
				"CONFLICT",
			);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("skill review and edit", () => {
	afterAll(closeDb);

	it("approves the reviewed hash only, recording the reviewer", async () => {
		await withApi(async ({ signIn, call, ns, operatorId, logRows }) => {
			await signIn();
			const source = await newSource(call);
			const draft = await newSkill(call, knowledgeBody(ns, source.id));
			const path = `/api/skills/${draft.id}/approve`;

			await expectFailure(
				await call(path, {
					method: "POST",
					body: { contentSha256: "0".repeat(64) },
				}),
				409,
				"CONFLICT",
			);
			const res = await call(path, {
				method: "POST",
				body: { contentSha256: draft.contentSha256 },
			});
			expect(res.status).toBe(200);
			expect(skillOne.parse(await res.json()).data).toMatchObject({
				status: "approved",
				reviewedBy: await operatorId(),
				reviewedAt: clock.now().toISOString(),
				version: 1,
			});
			await expectFailure(
				await call(path, {
					method: "POST",
					body: { contentSha256: draft.contentSha256 },
				}),
				409,
				"CONFLICT",
			);
			expect((await logRows(draft.id)).map((l) => l.action)).toEqual([
				"skill.created",
				"skill.approved",
			]);
		});
	});

	it("keeps approval for an unhashed edit and drops it for a hashed one", async () => {
		await withApi(async ({ signIn, call, ns, logRows }) => {
			await signIn();
			const source = await newSource(call);
			const draft = await newSkill(call, knowledgeBody(ns, source.id));
			await call(`/api/skills/${draft.id}/approve`, {
				method: "POST",
				body: { contentSha256: draft.contentSha256 },
			});

			const renamed = skillOne.parse(
				await (
					await call(`/api/skills/${draft.id}`, {
						method: "PATCH",
						body: { name: "Renamed", recommendedFor: ["domain"] },
					})
				).json(),
			).data;
			expect(renamed).toMatchObject({
				name: "Renamed",
				recommendedFor: ["domain"],
				status: "approved",
				version: 2,
				contentSha256: draft.contentSha256,
			});

			const edited = skillOne.parse(
				await (
					await call(`/api/skills/${draft.id}`, {
						method: "PATCH",
						body: { contentMd: "# Keyset, revised\n" },
					})
				).json(),
			).data;
			expect(edited).toMatchObject({
				status: "draft",
				reviewedBy: null,
				reviewedAt: null,
				version: 3,
				contentMd: "# Keyset, revised\n",
			});
			expect(edited.contentSha256).not.toBe(draft.contentSha256);

			const updates = (await logRows(draft.id)).filter(
				(l) => l.action === "skill.updated",
			);
			expect(updates.map((l) => l.payload)).toEqual([
				{
					fields: ["name", "recommendedFor"],
					version: 2,
					contentSha256: draft.contentSha256,
					returnedToDraft: false,
				},
				{
					fields: ["contentMd"],
					version: 3,
					contentSha256: edited.contentSha256,
					returnedToDraft: true,
				},
			]);
		});
	});

	it("moves between knowledge and capability only with consistent fields", async () => {
		await withApi(async ({ signIn, call, ns, tx }) => {
			await signIn();
			const source = await newSource(call);
			const draft = await newSkill(call, knowledgeBody(ns, source.id));
			const path = `/api/skills/${draft.id}`;

			const mismatch = await expectFailure(
				await call(path, {
					method: "PATCH",
					body: { grants: ["read:source"] },
				}),
				422,
				"PRECONDITION_FAILED",
			);
			expect(mismatch.details).toEqual({ reason: "skill_capability_mismatch" });
			await expectFailure(
				await call(path, { method: "PATCH", body: { type: "capability" } }),
				400,
				"VALIDATION_FAILED",
			);

			const capability = skillOne.parse(
				await (
					await call(path, {
						method: "PATCH",
						body: {
							type: "capability",
							grants: ["read:source"],
							ioShape: { reads: "small", returns: "small" },
						},
					})
				).json(),
			).data;
			expect(capability).toMatchObject({ type: "capability", version: 2 });

			const back = skillOne.parse(
				await (
					await call(path, { method: "PATCH", body: { type: "knowledge" } })
				).json(),
			).data;
			expect(back).toMatchObject({
				type: "knowledge",
				grants: null,
				ioShape: null,
				contentSha256: draft.contentSha256,
			});
			const [row] = await tx.select().from(skill).where(eq(skill.id, draft.id));
			expect(row?.grants).toBeNull();
		});
	});

	it("refuses a slug taken by another live skill with 409", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const source = await newSource(call);
			await newSkill(call, knowledgeBody(ns, source.id, "first"));
			const second = await newSkill(
				call,
				knowledgeBody(ns, source.id, "second"),
			);
			await expectFailure(
				await call(`/api/skills/${second.id}`, {
					method: "PATCH",
					body: { slug: `${ns}-first` },
				}),
				409,
				"CONFLICT",
			);
			// Its own slug is not a conflict.
			const same = await call(`/api/skills/${second.id}`, {
				method: "PATCH",
				body: { slug: `${ns}-second` },
			});
			expect(same.status).toBe(200);
		});
	});

	it("retires once, and a retired skill takes no edits or approval", async () => {
		await withApi(async ({ signIn, call, ns, logRows }) => {
			await signIn();
			const source = await newSource(call);
			const draft = await newSkill(call, knowledgeBody(ns, source.id));
			const retire = `/api/skills/${draft.id}/retire`;
			const res = await call(retire, { method: "POST" });
			expect(res.status).toBe(200);
			expect(skillOne.parse(await res.json()).data.status).toBe("retired");
			await expectFailure(
				await call(retire, { method: "POST" }),
				409,
				"CONFLICT",
			);
			await expectFailure(
				await call(`/api/skills/${draft.id}`, {
					method: "PATCH",
					body: { name: "Again" },
				}),
				409,
				"CONFLICT",
			);
			await expectFailure(
				await call(`/api/skills/${draft.id}/approve`, {
					method: "POST",
					body: { contentSha256: draft.contentSha256 },
				}),
				409,
				"CONFLICT",
			);
			const retired = (await logRows(draft.id)).find(
				(l) => l.action === "skill.retired",
			);
			expect(retired?.payload).toEqual({ from: "draft" });
		});
	});
});
