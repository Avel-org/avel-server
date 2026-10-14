import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { agentIdentityVersion, agentTemplate, user } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { IDENTITY_TOKEN_CAP } from "../../src/lib/identity";
import type { IdGenerator } from "../../src/lib/ids";
import { clock, inRollback, refusal } from "./fixtures";

async function newTemplate(tx: Tx, ids: IdGenerator, slug: string) {
	const id = ids.next();
	await tx.insert(agentTemplate).values({
		id,
		slug: `${slug}-${id}`,
		name: "Atlas",
		kind: "feature",
		roles: ["schema"],
		waveDefaults: ["B"],
		writablePaths: ["src/**"],
		version: 1,
		...stamp(clock),
	});
	return id;
}

const sha = (c: string) => c.repeat(64);

function version(
	ids: IdGenerator,
	agentTemplateId: string,
	over: Partial<typeof agentIdentityVersion.$inferInsert> = {},
): typeof agentIdentityVersion.$inferInsert {
	return {
		id: ids.next(),
		agentTemplateId,
		number: 1,
		identityMd: "# Atlas\n",
		depthMd: "",
		sha256: sha("a"),
		identityTokens: 0,
		depthTokens: IDENTITY_TOKEN_CAP,
		inputs: {
			generatorVersion: "1",
			slug: "atlas",
			name: "Atlas",
			kind: "feature",
			roles: ["schema"],
			writablePaths: ["src/**"],
			definitionsSha256: sha("d"),
			skills: [],
		},
		generatedBy: null,
		createdAt: clock.now(),
		...over,
	};
}

describe.skipIf(!process.env.DATABASE_URL)("agent_identity_version", () => {
	afterAll(closeDb);

	it("takes a seed-written version and an operator-written one", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			const nemi = await newTemplate(tx, ids, "nemi");
			const userId = ids.next();
			await tx.insert(user).values({
				id: userId,
				name: "Operator",
				email: `op-${userId}@example.com`,
				emailVerified: true,
				githubId: userId,
				githubLogin: "operator",
				...stamp(clock),
			});
			await tx.insert(agentIdentityVersion).values(version(ids, atlas));
			// The same text for another template is a different version.
			await tx
				.insert(agentIdentityVersion)
				.values(version(ids, nemi, { generatedBy: userId }));
			const rows = await tx
				.select({ n: agentIdentityVersion.number })
				.from(agentIdentityVersion)
				.where(eq(agentIdentityVersion.sha256, sha("a")));
			expect(rows).toHaveLength(2);
		});
	});

	it("requires both texts, and reads its inputs back typed", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			for (const column of ["identity_md", "depth_md"]) {
				const row = version(ids, atlas);
				const err = await refusal(tx, (t) =>
					t.execute(
						sql`insert into agent_identity_version (id, agent_template_id, number, identity_md, depth_md, sha256, identity_tokens, depth_tokens, inputs, created_at) values (${row.id}, ${atlas}, 1, ${column === "identity_md" ? null : "#"}, ${column === "depth_md" ? null : ""}, ${row.sha256}, 0, 0, '{}', ${clock.now().toISOString()}::timestamptz)`,
					),
				);
				expect(err.code, column).toBe("23502");
				expect(err.message, column).toContain(column);
			}
			const row = version(ids, atlas);
			await tx.insert(agentIdentityVersion).values(row);
			const [stored] = await tx
				.select({ inputs: agentIdentityVersion.inputs })
				.from(agentIdentityVersion)
				.where(eq(agentIdentityVersion.id, row.id));
			// Typed: a property access that would not compile on unknown.
			expect(stored?.inputs.definitionsSha256).toBe(sha("d"));
			expect(stored?.inputs).toEqual(row.inputs);
		});
	});

	it("refuses a repeated number or a repeated hash for one template", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			await tx.insert(agentIdentityVersion).values(version(ids, atlas));
			const sameNumber = await refusal(tx, (t) =>
				t
					.insert(agentIdentityVersion)
					.values(version(ids, atlas, { sha256: sha("b") })),
			);
			expect(sameNumber.constraint_name).toBe(
				"agent_identity_version_template_number_uq",
			);
			const sameHash = await refusal(tx, (t) =>
				t
					.insert(agentIdentityVersion)
					.values(version(ids, atlas, { number: 2 })),
			);
			expect(sameHash.constraint_name).toBe(
				"agent_identity_version_template_sha256_uq",
			);
		});
	});

	it("checks the number, the hash and both token counts", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			const cases: [
				Partial<typeof agentIdentityVersion.$inferInsert>,
				string,
			][] = [
				[{ number: 0 }, "agent_identity_version_number_positive"],
				[{ sha256: sha("A") }, "agent_identity_version_sha256_hex"],
				[{ sha256: "a".repeat(63) }, "agent_identity_version_sha256_hex"],
				[
					{ identityTokens: IDENTITY_TOKEN_CAP + 1 },
					"agent_identity_version_identity_tokens_range",
				],
				[
					{ identityTokens: -1 },
					"agent_identity_version_identity_tokens_range",
				],
				[
					{ depthTokens: IDENTITY_TOKEN_CAP + 1 },
					"agent_identity_version_depth_tokens_range",
				],
				[{ depthTokens: -1 }, "agent_identity_version_depth_tokens_range"],
			];
			for (const [over, constraint] of cases) {
				const err = await refusal(tx, (t) =>
					t.insert(agentIdentityVersion).values(version(ids, atlas, over)),
				);
				expect(err.constraint_name, JSON.stringify(over)).toBe(constraint);
			}
		});
	});

	it("bounds both token counts by the generator's cap, as the database states it", async () => {
		await inRollback(async (tx) => {
			const rows = await tx.execute<{ conname: string; def: string }>(
				sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
					where conrelid = 'agent_identity_version'::regclass
					and conname like '%tokens_range' order by conname`,
			);
			expect(rows.map((r) => r.conname)).toEqual([
				"agent_identity_version_depth_tokens_range",
				"agent_identity_version_identity_tokens_range",
			]);
			// Postgres states `between 0 and N` as `(x >= 0) AND (x <= N)`.
			for (const r of rows) {
				const bounds = /\(\w+ >= (\d+)\) AND \(\w+ <= (\d+)\)/.exec(r.def);
				expect(
					[Number(bounds?.[1]), Number(bounds?.[2])],
					`${r.conname}: ${r.def}`,
				).toEqual([0, IDENTITY_TOKEN_CAP]);
			}
		});
	});

	it("takes a file exactly at the cap", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			await tx.insert(agentIdentityVersion).values(
				version(ids, atlas, {
					identityTokens: IDENTITY_TOKEN_CAP,
					depthTokens: IDENTITY_TOKEN_CAP,
				}),
			);
		});
	});

	it("refuses UPDATE", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			const row = version(ids, atlas);
			await tx.insert(agentIdentityVersion).values(row);
			const err = await refusal(tx, (t) =>
				t
					.update(agentIdentityVersion)
					.set({ identityMd: "# Rewritten\n" })
					.where(eq(agentIdentityVersion.id, row.id)),
			);
			expect(err.message).toMatch(/append-only/);
		});
	});

	it("refuses DELETE", async () => {
		await inRollback(async (tx, ids) => {
			const atlas = await newTemplate(tx, ids, "atlas");
			const row = version(ids, atlas);
			await tx.insert(agentIdentityVersion).values(row);
			const err = await refusal(tx, (t) =>
				t
					.delete(agentIdentityVersion)
					.where(eq(agentIdentityVersion.id, row.id)),
			);
			expect(err.message).toMatch(/append-only/);
		});
	});

	it("refuses TRUNCATE", async () => {
		await inRollback(async (tx) => {
			// CASCADE: dispatch references this table (drizzle/0026), and a
			// plain TRUNCATE is refused for that before the trigger can run.
			const err = await refusal(tx, (t) =>
				t.execute(sql`truncate agent_identity_version cascade`),
			);
			expect(err.message).toMatch(/append-only/);
		});
	});
});
