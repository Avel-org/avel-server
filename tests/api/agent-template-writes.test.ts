import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	agentTemplateSchema,
	errorEnvelope,
	type Role,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { agentTemplate } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

const templateOne = successEnvelope(agentTemplateSchema);

const path = (id: string) => `/api/agent-templates/${id}`;

/** Templates under `ns`. */
function seeder(tx: Tx, ns: string) {
	let n = 0xd00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const template = async (
		roles: Role[] = ["domain"],
		over: Partial<typeof agentTemplate.$inferInsert> = {},
	) => {
		const templateId = id();
		await tx.insert(agentTemplate).values({
			id: templateId,
			slug: `${ns}-kel-${n}`,
			name: "Kel",
			kind: "horizontal",
			roles,
			waveDefaults: ["B"],
			title: "Domain engineer",
			description: "Writes the services and business rules.",
			writablePaths: ["src/services/**"],
			version: 1,
			...stamp(clock),
			...over,
		});
		return templateId;
	};
	const row = async (templateId: string) => {
		const [r] = await tx
			.select()
			.from(agentTemplate)
			.where(eq(agentTemplate.id, templateId));
		if (!r) throw new Error("template missing");
		return r;
	};
	return { template, row, id };
}

async function failure(res: Response, status: number) {
	expect(res.status).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

describe.skipIf(!process.env.DATABASE_URL)(
	"PATCH /api/agent-templates/:id",
	() => {
		afterAll(closeDb);

		it("edits each field, bumps the version and logs the field names", async () => {
			await withApi(async ({ signIn, operatorId, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				// Written a month before the clock, so the edit visibly moves updatedAt.
				const earlier = new Date("2026-09-05T12:00:00.000Z");
				const id = await s.template(["domain"], {
					createdAt: earlier,
					updatedAt: earlier,
				});
				const body = {
					writablePaths: ["src/services/**", "src/domain/**"],
					title: "Business rules engineer",
					description: "Owns services and the rules they enforce.",
					roles: ["domain", "api-surface"],
					waveDefaults: ["B", "C"],
				};
				const res = await call(path(id), { method: "PATCH", body });
				expect(res.status).toBe(200);
				const wire = templateOne.parse(await res.json()).data;
				expect(wire).toMatchObject({ ...body, version: 2 });

				const stored = await s.row(id);
				expect(stored).toMatchObject({ ...body, version: 2 });
				expect(stored.updatedAt).toEqual(clock.now());
				expect(stored.createdAt).toEqual(earlier);
				expect(wire.updatedAt).toBe(clock.now().toISOString());

				const logs = await logRows(id);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					actorKind: "operator",
					actorUserId: await operatorId(),
					action: "agent_template.updated",
					entityType: "agent_template",
					entityId: id,
					requestId: res.headers.get("x-request-id"),
				});
				expect(logs[0]?.payload).toEqual({
					fields: [
						"description",
						"roles",
						"title",
						"waveDefaults",
						"writablePaths",
					],
					version: 2,
				});
			});
		});

		it("edits one field alone and leaves the rest", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = seeder(tx, ns);
				const id = await s.template();
				const before = await s.row(id);
				for (const [body, version] of [
					[{ title: "Rules engineer" }, 2],
					[{ description: "Services only." }, 3],
					[{ roles: ["domain", "auth"] }, 4],
					[{ waveDefaults: ["C"] }, 5],
					[{ writablePaths: ["lib/**"] }, 6],
				] as const) {
					const res = await call(path(id), { method: "PATCH", body });
					expect(res.status, JSON.stringify(body)).toBe(200);
					expect((await s.row(id)).version).toBe(version);
				}
				const after = await s.row(id);
				expect(after).toMatchObject({
					slug: before.slug,
					name: before.name,
					kind: before.kind,
					engagementId: before.engagementId,
					title: "Rules engineer",
					description: "Services only.",
					roles: ["domain", "auth"],
					waveDefaults: ["C"],
					writablePaths: ["lib/**"],
				});
			});
		});

		it("clears title and description with null, and trims them", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = seeder(tx, ns);
				const id = await s.template();
				const cleared = await call(path(id), {
					method: "PATCH",
					body: { title: null, description: null },
				});
				expect(templateOne.parse(await cleared.json()).data).toMatchObject({
					title: null,
					description: null,
				});
				expect(await s.row(id)).toMatchObject({
					title: null,
					description: null,
				});

				const trimmed = await call(path(id), {
					method: "PATCH",
					body: {
						title: "  Domain engineer  ",
						description: "\tPlain words.\n",
					},
				});
				expect(templateOne.parse(await trimmed.json()).data).toMatchObject({
					title: "Domain engineer",
					description: "Plain words.",
				});
			});
		});

		it("dedupes roles and waveDefaults, keeping first order", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = seeder(tx, ns);
				const id = await s.template();
				const res = await call(path(id), {
					method: "PATCH",
					body: {
						roles: ["state", "domain", "state"],
						waveDefaults: ["C", "B", "C"],
					},
				});
				expect(templateOne.parse(await res.json()).data).toMatchObject({
					roles: ["state", "domain"],
					waveDefaults: ["C", "B"],
				});
			});
		});

		it("refuses a bad body with 400 and writes nothing", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				const id = await s.template();
				for (const body of [
					{},
					{ slug: "renamed" },
					{ name: "Renamed" },
					{ kind: "feature" },
					{ engagementId: s.id() },
					{ title: "" },
					{ title: "   " },
					{ title: "a".repeat(61) },
					{ description: "" },
					{ description: "a".repeat(281) },
					{ description: "Uses **bold**." },
					{ description: "snake_case" },
					{ description: "Has `code`." },
					{ description: "# Heading" },
					{ description: "One — two" },
					{ roles: [] },
					{ roles: ["builder"] },
					{ waveDefaults: ["F"] },
					{ writablePaths: [""] },
					{ writablePaths: [] },
					{ title: "**Lead**" },
					{ title: "api_surface" },
					{ title: "`Kel`" },
					{ title: "#1 engineer" },
					{ title: "Kel — domain" },
					{ title: "Fine", extra: 1 },
				]) {
					const error = await failure(
						await call(path(id), { method: "PATCH", body }),
						400,
					);
					expect(error.code, JSON.stringify(body)).toBe("VALIDATION_FAILED");
				}
				expect((await s.row(id)).version).toBe(1);
				expect(await logRows(id)).toEqual([]);
			});
		});

		it("takes the longest title and description, and empty waveDefaults", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const id = await seeder(tx, ns).template();
				const res = await call(path(id), {
					method: "PATCH",
					body: {
						title: "a".repeat(60),
						description: "a".repeat(280),
						waveDefaults: [],
					},
				});
				expect(res.status).toBe(200);
			});
		});

		describe("roles across sides (422 agent_roles_cross_sides)", () => {
			for (const [roles, sides] of [
				[
					["domain", "backend-tests"],
					["author", "tester"],
				],
				[
					["frontend-tests", "spec-judgment"],
					["tester", "judge"],
				],
				[
					["interface", "security-review"],
					["author", "judge"],
				],
				[
					["schema", "incident-response"],
					["author", "judge"],
				],
				[
					["fixture", "domain"],
					["author", "fixture"],
				],
				[["fixture", "intake"], ["fixture"]],
			] as [Role[], string[]][]) {
				it(`refuses ${roles.join(" + ")}`, async () => {
					await withApi(async ({ signIn, call, tx, ns, logRows }) => {
						await signIn();
						const s = seeder(tx, ns);
						const id = await s.template();
						const error = await failure(
							await call(path(id), { method: "PATCH", body: { roles } }),
							422,
						);
						expect(error.code).toBe("PRECONDITION_FAILED");
						expect(error.details).toEqual({
							reason: "agent_roles_cross_sides",
							sides,
						});
						expect(await s.row(id)).toMatchObject({
							roles: ["domain"],
							version: 1,
						});
						expect(await logRows(id)).toEqual([]);
					});
				});
			}
		});

		describe("roles no agent may hold (422 agent_role_not_assignable)", () => {
			it("refuses a code role, pointing at its index", async () => {
				await withApi(async ({ signIn, call, tx, ns, logRows }) => {
					await signIn();
					const s = seeder(tx, ns);
					const id = await s.template();
					const error = await failure(
						await call(path(id), {
							method: "PATCH",
							body: { roles: ["domain", "spec-check"] },
						}),
						422,
					);
					expect(error.code).toBe("PRECONDITION_FAILED");
					expect(error.details).toEqual({
						reason: "agent_role_not_assignable",
						issues: [{ path: ["roles", 1], message: expect.any(String) }],
					});
					expect((await s.row(id)).version).toBe(1);
					expect(await logRows(id)).toEqual([]);
				});
			});

			it("refuses foundations with another role, and takes it alone", async () => {
				await withApi(async ({ signIn, call, tx, ns }) => {
					await signIn();
					const s = seeder(tx, ns);
					const id = await s.template();
					const error = await failure(
						await call(path(id), {
							method: "PATCH",
							body: { roles: ["foundations", "domain"] },
						}),
						422,
					);
					expect(error.details).toEqual({
						reason: "agent_role_not_assignable",
						issues: [{ path: ["roles", 0], message: expect.any(String) }],
					});
					const alone = await call(path(id), {
						method: "PATCH",
						body: { roles: ["foundations"] },
					});
					expect(alone.status).toBe(200);
				});
			});

			it("names every offending role, before any side check", async () => {
				await withApi(async ({ signIn, call, tx, ns }) => {
					await signIn();
					const id = await seeder(tx, ns).template();
					const error = await failure(
						await call(path(id), {
							method: "PATCH",
							body: { roles: ["deploy", "domain", "backend-tests", "render"] },
						}),
						422,
					);
					expect(error.details).toEqual({
						reason: "agent_role_not_assignable",
						issues: [
							{ path: ["roles", 0], message: expect.any(String) },
							{ path: ["roles", 3], message: expect.any(String) },
						],
					});
				});
			});
		});

		it("reads stale after a roles or paths change, not after a title change", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const id = await seeder(tx, ns).template();
				const regen = await call(`${path(id)}/identity/regenerate`, {
					method: "POST",
				});
				expect(regen.status).toBe(201);

				const titled = templateOne.parse(
					await (
						await call(path(id), {
							method: "PATCH",
							body: { title: "Renamed" },
						})
					).json(),
				).data;
				expect(titled).toMatchObject({
					identityVersion: 1,
					identityStale: false,
					staleInputs: [],
				});

				const roled = templateOne.parse(
					await (
						await call(path(id), {
							method: "PATCH",
							body: { roles: ["domain", "state"] },
						})
					).json(),
				).data;
				expect(roled).toMatchObject({
					identityVersion: 1,
					identityStale: true,
					staleInputs: ["roles", "definitionsSha256"],
				});

				const pathed = templateOne.parse(
					await (
						await call(path(id), {
							method: "PATCH",
							body: { roles: ["domain"], writablePaths: ["lib/**"] },
						})
					).json(),
				).data;
				expect(pathed).toMatchObject({
					identityStale: true,
					staleInputs: ["writablePaths"],
				});
			});
		});

		it("answers 404 for an unknown or deleted template", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = seeder(tx, ns);
				const gone = await s.template(["domain"], { deletedAt: clock.now() });
				for (const id of [gone, s.id()]) {
					const error = await failure(
						await call(path(id), { method: "PATCH", body: { title: "X" } }),
						404,
					);
					expect(error.code).toBe("NOT_FOUND");
				}
				expect((await s.row(gone)).version).toBe(1);
			});
		});

		it("answers 401 without a session, and writes nothing", async () => {
			await withApi(async ({ call, tx, ns }) => {
				const s = seeder(tx, ns);
				const id = await s.template();
				const error = await failure(
					await call(path(id), { method: "PATCH", body: { title: "X" } }),
					401,
				);
				expect(error.code).toBe("UNAUTHENTICATED");
				expect((await s.row(id)).version).toBe(1);
			});
		});
	},
);
