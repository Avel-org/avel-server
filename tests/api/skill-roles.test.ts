import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	preconditionDetails,
	skillSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import type { ApiHarness } from "./support";
import { withApi } from "./support";

// PUT /api/skills/:id/roles (J, 2026-10-24): an approved role skill reaches
// identities once it is attached to a role.

const skillOne = successEnvelope(skillSchema);
type Call = ApiHarness["call"];

async function newSource(call: Call) {
	const res = await call("/api/skill-sources", {
		method: "POST",
		body: { name: "Internal", kind: "internal" },
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { data: { id: string } }).data.id;
}

async function newSkill(
	call: Call,
	ns: string,
	sourceId: string,
	over: Record<string, unknown> = {},
) {
	const res = await call("/api/skills", {
		method: "POST",
		body: {
			slug: `${ns}-property-tests`,
			name: "Property testing invariants",
			description: "Use when a rule must hold for every input.",
			contentMd: "# Property tests\n\nState the invariant first.\n",
			layer: "role",
			type: "knowledge",
			recommendedFor: ["domain"],
			sourceId,
			...over,
		},
	});
	expect(res.status, await res.clone().text()).toBe(201);
	return skillOne.parse(await res.json()).data;
}

const setRoles = (call: Call, id: string, roles: string[]) =>
	call(`/api/skills/${id}/roles`, { method: "PUT", body: { roles } });

async function rolesOf(res: Response) {
	expect(res.status, await res.clone().text()).toBe(200);
	return skillOne.parse(await res.json()).data.attachedRoles;
}

describe.skipIf(!process.env.DATABASE_URL)("PUT /api/skills/:id/roles", () => {
	afterAll(closeDb);

	it("sets the skill's roles in ROLES order, shows them on every read, and logs each change once", async () => {
		await withApi(async ({ signIn, call, ns, logRows }) => {
			await signIn();
			const source = await newSource(call);
			const s = await newSkill(call, ns, source);
			expect(s.attachedRoles).toEqual([]);

			expect(
				await rolesOf(
					await setRoles(call, s.id, ["api-surface", "domain", "domain"]),
				),
			).toEqual(["domain", "api-surface"]);
			expect(await rolesOf(await call(`/api/skills/${s.id}`))).toEqual([
				"domain",
				"api-surface",
			]);
			expect(
				await rolesOf(await call(`/api/skills/by-slug/${s.slug}`)),
			).toEqual(["domain", "api-surface"]);
			// The same set again changes nothing and logs nothing.
			await rolesOf(await setRoles(call, s.id, ["domain", "api-surface"]));
			expect(await rolesOf(await setRoles(call, s.id, ["domain"]))).toEqual([
				"domain",
			]);
			expect(await rolesOf(await setRoles(call, s.id, []))).toEqual([]);

			const logged = (await logRows(s.id))
				.filter((l) => l.action === "skill.roles_set")
				.map((l) => l.payload);
			expect(logged).toEqual([
				{ skillId: s.id, from: [], to: ["domain", "api-surface"] },
				{ skillId: s.id, from: ["domain", "api-surface"], to: ["domain"] },
				{ skillId: s.id, from: ["domain"], to: [] },
			]);
		});
	});

	it("refuses a stack skill and a retired one, and attaches nothing", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const source = await newSource(call);
			const stack = await newSkill(call, ns, source, {
				slug: `${ns}-keyset`,
				layer: "stack",
			});
			const res = await setRoles(call, stack.id, ["domain"]);
			expect(res.status).toBe(422);
			const { error } = errorEnvelope.parse(await res.json());
			expect(preconditionDetails.parse(error.details).reason).toBe(
				"skill_not_role_layer",
			);

			const role = await newSkill(call, ns, source);
			expect(
				(await call(`/api/skills/${role.id}/retire`, { method: "POST" }))
					.status,
			).toBe(200);
			const retired = await setRoles(call, role.id, ["domain"]);
			expect(retired.status).toBe(409);
			expect(errorEnvelope.parse(await retired.json()).error.code).toBe(
				"CONFLICT",
			);

			for (const id of [stack.id, role.id]) {
				expect(await rolesOf(await call(`/api/skills/${id}`))).toEqual([]);
			}
		});
	});

	it("makes a template holding the role stale once the approved skill is attached, and its next identity carries the skill in full", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const created = await call("/api/agent-templates", {
				method: "POST",
				body: {
					slug: `kel-${ns}`,
					name: "Kel",
					kind: "horizontal",
					roles: ["domain"],
					waveDefaults: ["B"],
					writablePaths: ["src/**"],
				},
			});
			expect(created.status, await created.clone().text()).toBe(201);
			const t = ((await created.json()) as { data: { id: string } }).data;
			const regenerate = () =>
				call(`/api/agent-templates/${t.id}/identity/regenerate`, {
					method: "POST",
				});
			expect((await regenerate()).status).toBe(201);
			const stale = async () =>
				(
					(await (await call(`/api/agent-templates/${t.id}`)).json()) as {
						data: { identityStale: boolean };
					}
				).data.identityStale;
			expect(await stale()).toBe(false);

			const source = await newSource(call);
			const s = await newSkill(call, ns, source);
			const approved = await call(`/api/skills/${s.id}/approve`, {
				method: "POST",
				body: { contentSha256: s.contentSha256 },
			});
			expect(approved.status).toBe(200);
			await rolesOf(await setRoles(call, s.id, ["domain"]));
			expect(await stale()).toBe(true);

			expect((await regenerate()).status).toBe(201);
			expect(await stale()).toBe(false);
			const v2 = (await (
				await call(`/api/agent-templates/${t.id}/identity/versions/2`)
			).json()) as { data: { identityMd: string; depthMd: string } };
			expect(v2.data.identityMd).toContain(s.slug);
			expect(v2.data.depthMd).toContain("State the invariant first.");
		});
	});
});
