import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	agentTemplateSchema,
	errorEnvelope,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	client,
	engagement,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

const templateOne = successEnvelope(agentTemplateSchema);

const PATH = "/api/agent-templates";

async function failure(res: Response, status: number) {
	expect(res.status, await res.clone().text()).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

/** Ids, a client with an engagement, and lookups under `ns`. */
function seeder(tx: Tx, ns: string) {
	let n = 0xe00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const engagementOf = async (
		over: Partial<typeof engagement.$inferInsert> = {},
	) => {
		const clientId = id();
		await tx.insert(client).values({
			id: clientId,
			name: `Client ${ns} ${n}`,
			status: "active",
			...stamp(clock),
		});
		const engagementId = id();
		await tx.insert(engagement).values({
			id: engagementId,
			clientId,
			name: "Portal",
			status: "active",
			startedAt: clock.now(),
			...stamp(clock),
			...over,
		});
		return engagementId;
	};
	/** Live templates with this slug. */
	const bySlug = (slug: string) =>
		tx
			.select()
			.from(agentTemplate)
			.where(
				and(eq(agentTemplate.slug, slug), isNull(agentTemplate.deletedAt)),
			);
	const createdLogs = (slug: string) =>
		tx
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "agent_template.created"),
					eq(activityLog.payload, { slug, version: 1 }),
				),
			);
	return { id, engagementOf, bySlug, createdLogs };
}

describe.skipIf(!process.env.DATABASE_URL)("POST /api/agent-templates", () => {
	afterAll(closeDb);

	const body = (ns: string, over: Record<string, unknown> = {}) => ({
		slug: `atlas-${ns}`,
		name: "Atlas",
		kind: "feature",
		roles: ["domain", "api-surface"],
		waveDefaults: ["A"],
		writablePaths: ["src/features/scheduling/**"],
		...over,
	});

	it("creates a shared template at version 1 with no identity, and logs it in the same transaction", async () => {
		await withApi(async ({ signIn, operatorId, call, tx, ns, logRows }) => {
			await signIn();
			const s = seeder(tx, ns);
			const res = await call(PATH, {
				method: "POST",
				body: body(ns, {
					title: "Scheduling builder",
					description: "Builds the booking flow.",
				}),
			});
			expect(res.status, await res.clone().text()).toBe(201);
			const wire = templateOne.parse(await res.json()).data;
			expect(wire).toEqual({
				id: expect.any(String),
				slug: `atlas-${ns}`,
				name: "Atlas",
				kind: "feature",
				roles: ["domain", "api-surface"],
				engagementId: null,
				waveDefaults: ["A"],
				title: "Scheduling builder",
				description: "Builds the booking flow.",
				writablePaths: ["src/features/scheduling/**"],
				identityVersion: null,
				identitySha256: null,
				identityStale: false,
				staleInputs: [],
				version: 1,
				createdAt: clock.now().toISOString(),
				updatedAt: clock.now().toISOString(),
			});
			const [stored] = await s.bySlug(`atlas-${ns}`);
			expect(stored?.id).toBe(wire.id);

			const logs = await logRows(wire.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				actorKind: "operator",
				actorUserId: await operatorId(),
				action: "agent_template.created",
				entityType: "agent_template",
				entityId: wire.id,
				engagementId: null,
				requestId: res.headers.get("x-request-id"),
				payload: { slug: `atlas-${ns}`, version: 1 },
			});

			// The route reads it back, and regenerate makes its first identity.
			const got = await call(`${PATH}/${wire.id}`);
			expect(templateOne.parse(await got.json()).data).toEqual(wire);
			const regen = await call(`${PATH}/${wire.id}/identity/regenerate`, {
				method: "POST",
			});
			expect(regen.status, await regen.clone().text()).toBe(201);
		});
	});

	it("defaults title and description to null, trims the name, and dedupes roles and waveDefaults", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const res = await call(PATH, {
				method: "POST",
				body: body(ns, {
					name: "  Atlas  ",
					roles: ["domain", "api-surface", "domain"],
					waveDefaults: ["B", "A", "B"],
				}),
			});
			expect(res.status).toBe(201);
			expect(templateOne.parse(await res.json()).data).toMatchObject({
				name: "Atlas",
				roles: ["domain", "api-surface"],
				waveDefaults: ["B", "A"],
				title: null,
				description: null,
			});
		});
	});

	it("scopes a template to an engagement, closed or not, and logs the engagement", async () => {
		await withApi(async ({ signIn, call, tx, ns, logRows }) => {
			await signIn();
			const s = seeder(tx, ns);
			for (const status of ["active", "closed"] as const) {
				const engagementId = await s.engagementOf({ status });
				const res = await call(PATH, {
					method: "POST",
					body: body(ns, { slug: `atlas-${status}-${ns}`, engagementId }),
				});
				expect(res.status, await res.clone().text()).toBe(201);
				const wire = templateOne.parse(await res.json()).data;
				expect(wire.engagementId).toBe(engagementId);
				expect((await logRows(wire.id))[0]?.engagementId).toBe(engagementId);
			}
		});
	});

	it("refuses an unknown or deleted engagement with 422 engagement_not_found, and writes nothing", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = seeder(tx, ns);
			const deleted = await s.engagementOf({ deletedAt: clock.now() });
			for (const engagementId of [deleted, s.id()]) {
				const error = await failure(
					await call(PATH, {
						method: "POST",
						body: body(ns, { engagementId }),
					}),
					422,
				);
				expect(error.details).toEqual({
					reason: "engagement_not_found",
					engagementId,
				});
			}
			expect(await s.bySlug(`atlas-${ns}`)).toEqual([]);
			expect(await s.createdLogs(`atlas-${ns}`)).toEqual([]);
		});
	});

	it("refuses a slug a live template holds with 409, and takes a deleted template's slug", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = seeder(tx, ns);
			const first = await call(PATH, { method: "POST", body: body(ns) });
			expect(first.status).toBe(201);
			const error = await failure(
				await call(PATH, {
					method: "POST",
					body: body(ns, { name: "Another" }),
				}),
				409,
			);
			expect(error.code).toBe("CONFLICT");
			expect(await s.bySlug(`atlas-${ns}`)).toHaveLength(1);
			expect(await s.createdLogs(`atlas-${ns}`)).toHaveLength(1);

			await tx
				.update(agentTemplate)
				.set({ deletedAt: clock.now() })
				.where(eq(agentTemplate.slug, `atlas-${ns}`));
			const again = await call(PATH, { method: "POST", body: body(ns) });
			expect(again.status, await again.clone().text()).toBe(201);
		});
	});

	it("refuses a bad body with 400 and writes nothing", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = seeder(tx, ns);
			const { slug: _slug, ...noSlug } = body(ns);
			for (const bad of [
				noSlug,
				body(ns, { slug: `Atlas_${ns}` }),
				body(ns, { slug: `atlas--${ns}` }),
				body(ns, { slug: "a".repeat(101) }),
				body(ns, { name: "   " }),
				body(ns, { kind: "vertical" }),
				body(ns, { roles: [] }),
				body(ns, { roles: ["wizard"] }),
				body(ns, { waveDefaults: ["F"] }),
				body(ns, { writablePaths: [] }),
				body(ns, { writablePaths: [""] }),
				body(ns, { title: "**Bold**" }),
				body(ns, { description: "x".repeat(281) }),
				body(ns, { engagementId: "not-a-uuid" }),
				body(ns, { version: 2 }),
			]) {
				const error = await failure(
					await call(PATH, { method: "POST", body: bad }),
					400,
				);
				expect(error.code, JSON.stringify(bad)).toBe("VALIDATION_FAILED");
			}
			expect(await s.bySlug(`atlas-${ns}`)).toEqual([]);
		});
	});

	it("refuses roles across sides and roles no agent may hold, as the edit does, and writes nothing", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			await signIn();
			const s = seeder(tx, ns);
			const crossed = await failure(
				await call(PATH, {
					method: "POST",
					body: body(ns, { roles: ["domain", "backend-tests"] }),
				}),
				422,
			);
			expect(crossed.details).toEqual({
				reason: "agent_roles_cross_sides",
				sides: ["author", "tester"],
			});
			const code = await failure(
				await call(PATH, {
					method: "POST",
					body: body(ns, { roles: ["domain", "spec-check"] }),
				}),
				422,
			);
			expect(code.details).toEqual({
				reason: "agent_role_not_assignable",
				issues: [{ path: ["roles", 1], message: expect.any(String) }],
			});
			expect(await s.bySlug(`atlas-${ns}`)).toEqual([]);
			expect(await s.createdLogs(`atlas-${ns}`)).toEqual([]);
		});
	});

	it("takes a Firm role: a new template sits on no roster", async () => {
		await withApi(async ({ signIn, call, ns }) => {
			await signIn();
			const res = await call(PATH, {
				method: "POST",
				body: body(ns, { roles: ["intake"] }),
			});
			expect(res.status, await res.clone().text()).toBe(201);
			expect(templateOne.parse(await res.json()).data.roles).toEqual([
				"intake",
			]);
		});
	});

	it("answers 401 without a session, and writes nothing", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const error = await failure(
				await call(PATH, { method: "POST", body: body(ns) }),
				401,
			);
			expect(error.code).toBe("UNAUTHENTICATED");
			expect(await seeder(tx, ns).bySlug(`atlas-${ns}`)).toEqual([]);
		});
	});
});
