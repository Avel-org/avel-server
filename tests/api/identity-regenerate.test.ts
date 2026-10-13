import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	IDENTITY_TOKEN_CAP,
	identityRegenerated,
	identityUnchanged,
	type Role,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	agentIdentityVersion,
	agentTemplate,
	roleSkills,
	skill,
	skillSource,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { clock, withApi } from "./support";

const created = successEnvelope(identityRegenerated);
const unchanged = successEnvelope(identityUnchanged);

const regenerate = (id: string) =>
	`/api/agent-templates/${id}/identity/regenerate`;

/** Templates and role skills under `ns`. */
function seeder(tx: Tx, ns: string) {
	let n = 0xf00;
	const id = () => {
		n += 1;
		return `${ns}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const template = async (
		roles: Role[],
		over: Partial<typeof agentTemplate.$inferInsert> = {},
	) => {
		const templateId = id();
		const slug = `${ns}-atlas-${n}`;
		await tx.insert(agentTemplate).values({
			id: templateId,
			slug,
			name: "Atlas",
			kind: "feature",
			roles,
			waveDefaults: ["B"],
			writablePaths: ["src/modules/scheduling/**"],
			version: 1,
			...stamp(clock),
			...over,
		});
		return { id: templateId, slug };
	};
	const roleSkill = async (role: Role, contentMd: string) => {
		const sourceId = id();
		await tx.insert(skillSource).values({
			id: sourceId,
			name: `Source ${ns}`,
			kind: "internal",
			...stamp(clock),
		});
		const skillId = id();
		await tx.insert(skill).values({
			id: skillId,
			slug: `${ns}-skill-${n}`,
			name: "Long skill",
			description: "Read the tables first.",
			contentMd,
			layer: "role",
			type: "knowledge",
			recommendedFor: [role],
			sourceId,
			contentSha256: "c".repeat(64),
			status: "approved",
			version: 1,
			...stamp(clock),
		});
		await tx.insert(roleSkills).values({ role, skillId });
	};
	const setRoles = (templateId: string, roles: Role[]) =>
		tx
			.update(agentTemplate)
			.set({ roles })
			.where(eq(agentTemplate.id, templateId));
	const versions = (templateId: string) =>
		tx
			.select()
			.from(agentIdentityVersion)
			.where(eq(agentIdentityVersion.agentTemplateId, templateId));
	return { template, roleSkill, setRoles, versions, id };
}

async function failure(res: Response, status: number) {
	expect(res.status).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

describe.skipIf(!process.env.DATABASE_URL)(
	"POST /api/agent-templates/:id/identity/regenerate",
	() => {
		afterAll(closeDb);

		it("creates version 1 (201), by the operator, and logs it once", async () => {
			await withApi(async ({ signIn, operatorId, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				const t = await s.template(["domain"]);

				const res = await call(regenerate(t.id), { method: "POST" });
				expect(res.status).toBe(201);
				const body = created.parse(await res.json());
				const operator = await operatorId();
				expect(body.data).toMatchObject({
					created: true,
					version: {
						ref: `${t.slug}@v1`,
						number: 1,
						generatedBy: operator,
						createdAt: clock.now().toISOString(),
					},
				});
				const [row] = await s.versions(t.id);
				expect(body.data.version.sha256).toBe(row?.sha256);

				const logs = await logRows(t.id);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({
					actorKind: "operator",
					actorUserId: operator,
					action: "agent_template.identity_regenerated",
					entityType: "agent_template",
					entityId: t.id,
					requestId: res.headers.get("x-request-id"),
				});
				// Exactly these keys: toMatchObject above would accept extras.
				expect(logs[0]?.payload).toEqual({ number: 1, sha256: row?.sha256 });
			});
		});

		it("answers 200, writes nothing and logs nothing when the text is unchanged", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				const t = await s.template(["domain"]);
				const first = created.parse(
					await (await call(regenerate(t.id), { method: "POST" })).json(),
				);

				const res = await call(regenerate(t.id), { method: "POST" });
				expect(res.status).toBe(200);
				expect(unchanged.parse(await res.json()).data).toEqual({
					created: false,
					reused: false,
					version: first.data.version,
				});
				expect(await s.versions(t.id)).toHaveLength(1);
				expect(await logRows(t.id)).toHaveLength(1);
			});
		});

		it("numbers a changed identity 2, and reuses 1 when the inputs return", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				const t = await s.template(["domain"]);
				const v1 = created.parse(
					await (await call(regenerate(t.id), { method: "POST" })).json(),
				).data.version;

				await s.setRoles(t.id, ["domain", "api-surface"]);
				const second = await call(regenerate(t.id), { method: "POST" });
				expect(second.status).toBe(201);
				expect(created.parse(await second.json()).data.version).toMatchObject({
					ref: `${t.slug}@v2`,
					number: 2,
				});

				await s.setRoles(t.id, ["domain"]);
				const back = await call(regenerate(t.id), { method: "POST" });
				expect(back.status).toBe(200);
				expect(unchanged.parse(await back.json()).data).toEqual({
					created: false,
					reused: true,
					version: v1,
				});
				expect(await s.versions(t.id)).toHaveLength(2);

				// The two new versions are logged; the reuse changes nothing and is not.
				const logs = await logRows(t.id);
				expect(logs).toHaveLength(2);
				expect(
					logs.map((l) => (l.payload as { number: number }).number).sort(),
				).toEqual([1, 2]);
				expect(logs.map((l) => l.requestId)).not.toContain(
					back.headers.get("x-request-id"),
				);
			});
		});

		it("accepts an empty JSON body", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const t = await seeder(tx, ns).template(["domain"]);
				const res = await call(regenerate(t.id), { method: "POST", body: {} });
				expect(res.status).toBe(201);
			});
		});

		it("refuses the operator's template (422 identity_role_unsupported)", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				const t = await s.template(["foundations"], { kind: "horizontal" });
				const error = await failure(
					await call(regenerate(t.id), { method: "POST" }),
					422,
				);
				expect(error.code).toBe("PRECONDITION_FAILED");
				expect(error.details).toEqual({ reason: "identity_role_unsupported" });
				expect(await s.versions(t.id)).toEqual([]);
				expect(await logRows(t.id)).toEqual([]);
			});
		});

		it("refuses a depth file over the cap, naming the file, tokens and cap", async () => {
			await withApi(async ({ signIn, call, tx, ns, logRows }) => {
				await signIn();
				const s = seeder(tx, ns);
				await s.roleSkill(
					"domain",
					`# Long\n\n${"Read before writing. ".repeat(300)}`,
				);
				const t = await s.template(["domain"]);
				const error = await failure(
					await call(regenerate(t.id), { method: "POST" }),
					422,
				);
				expect(error.code).toBe("PRECONDITION_FAILED");
				expect(error.details).toEqual({
					reason: "identity_over_token_cap",
					file: "depth",
					tokens: expect.any(Number),
					cap: IDENTITY_TOKEN_CAP,
				});
				expect((error.details as { tokens: number }).tokens).toBeGreaterThan(
					IDENTITY_TOKEN_CAP,
				);
				expect(await s.versions(t.id)).toEqual([]);
				expect(await logRows(t.id)).toEqual([]);
			});
		});

		it("refuses an identity file over the cap", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const paths = Array.from(
					{ length: 200 },
					(_, i) => `src/modules/scheduling/part-${i}/**`,
				);
				const t = await seeder(tx, ns).template(["domain"], {
					writablePaths: paths,
				});
				const error = await failure(
					await call(regenerate(t.id), { method: "POST" }),
					422,
				);
				expect(error.details).toMatchObject({
					reason: "identity_over_token_cap",
					file: "identity",
					cap: IDENTITY_TOKEN_CAP,
				});
			});
		});

		it("answers 404 for an unknown or deleted template, 400 for a bad id", async () => {
			await withApi(async ({ signIn, call, tx, ns }) => {
				await signIn();
				const s = seeder(tx, ns);
				const gone = await s.template(["domain"], { deletedAt: clock.now() });
				for (const id of [gone.id, s.id()]) {
					const error = await failure(
						await call(regenerate(id), { method: "POST" }),
						404,
					);
					expect(error.code).toBe("NOT_FOUND");
				}
				expect(await s.versions(gone.id)).toEqual([]);
				const bad = await failure(
					await call(regenerate("not-a-uuid"), { method: "POST" }),
					400,
				);
				expect(bad.code).toBe("VALIDATION_FAILED");
			});
		});

		it("answers 401 without a session, and writes nothing", async () => {
			await withApi(async ({ call, tx, ns }) => {
				const s = seeder(tx, ns);
				const t = await s.template(["domain"]);
				const error = await failure(
					await call(regenerate(t.id), { method: "POST" }),
					401,
				);
				expect(error.code).toBe("UNAUTHENTICATED");
				expect(await s.versions(t.id)).toEqual([]);
			});
		});
	},
);
