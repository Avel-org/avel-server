import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClientId } from "../../src/db/client-id";
import { engagement, file, intake, intakeFiles } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { type Tx, withClientScope, withTx } from "../../src/db/tx";
import { connectAsApp, one, seedTenants } from "./app-role";
import { clock, inRollback, refusal } from "./fixtures";

// Row-level security on file and intake_files (drizzle/0028_drive.sql). Every
// test here connects as avel_app, never postgres: a superuser bypasses RLS,
// so a test run as postgres would pass with no policy at all.

const RLS_REFUSED = "42501";

type FileScope = { clientId?: string; engagementId?: string };

function fileValues(uploadedBy: string, at: FileScope = {}) {
	return {
		id: randomUUID(),
		scope: at.engagementId
			? ("engagement" as const)
			: at.clientId
				? ("client" as const)
				: ("general" as const),
		clientId: at.clientId ?? null,
		engagementId: at.engagementId ?? null,
		name: "brief.md",
		mime: "text/markdown",
		bytes: 12,
		sha256: "a".repeat(64),
		storageKey: "a".repeat(64),
		uploadedBy,
		...stamp(clock),
	};
}

async function visibleFileIds(tx: Tx) {
	const rows = await tx.select({ id: file.id }).from(file);
	return rows.map((r) => r.id).sort();
}

describe.skipIf(!process.env.DATABASE_URL)("client isolation", () => {
	let app: ReturnType<typeof connectAsApp>;
	beforeAll(() => {
		app = connectAsApp();
	});
	afterAll(() => app.end());

	class Rollback extends Error {}
	async function asApp(fn: (tx: Tx) => Promise<void>) {
		await withTx(app.db, async (tx) => {
			await fn(tx);
			throw new Rollback();
		}).catch((e: unknown) => {
			if (!(e instanceof Rollback)) throw e;
		});
	}

	/** Two clients, each with one client file, plus one general file. */
	async function seedFiles(tx: Tx) {
		const { userId, a, b } = await seedTenants(tx, ["Meridian", "Halcyon"]);
		const general = fileValues(userId);
		const fileA = fileValues(userId, { clientId: a.clientId });
		const fileB = fileValues(userId, {
			clientId: b.clientId,
			engagementId: b.engagementId,
		});
		await tx.insert(file).values(general);
		await withClientScope(tx, a.scope, (t) => t.insert(file).values(fileA));
		await withClientScope(tx, b.scope, (t) => t.insert(file).values(fileB));
		return { userId, a, b, general, fileA, fileB };
	}

	it("a client's scope reads its own files and the general ones, never another client's", async () => {
		await asApp(async (tx) => {
			const { a, b, general, fileA, fileB } = await seedFiles(tx);
			const seen = await withClientScope(tx, a.scope, visibleFileIds);
			expect(seen).toContain(fileA.id);
			expect(seen).toContain(general.id);
			expect(seen).not.toContain(fileB.id);
			const seenB = await withClientScope(tx, b.scope, visibleFileIds);
			expect(seenB).toContain(fileB.id);
			expect(seenB).toContain(general.id);
			expect(seenB).not.toContain(fileA.id);
		});
	});

	it("shows a general file under every client's scope, and a client's file under no other", async () => {
		await asApp(async (tx) => {
			const { userId, tenants, a } = await seedTenants(tx, ["A", "B", "C"]);
			const general = fileValues(userId);
			await tx.insert(file).values(general);
			const owned = fileValues(userId, { clientId: a.clientId });
			await withClientScope(tx, a.scope, (t) => t.insert(file).values(owned));
			for (const [i, t] of tenants.entries()) {
				const seen = await withClientScope(tx, t.scope, visibleFileIds);
				expect(seen).toContain(general.id);
				expect(seen.includes(owned.id)).toBe(i === 0);
			}
		});
	});

	it("with no scope set, reads only general files: no client's rows", async () => {
		await asApp(async (tx) => {
			const { general, fileA, fileB } = await seedFiles(tx);
			const seen = await visibleFileIds(tx);
			expect(seen).toContain(general.id);
			expect(seen).not.toContain(fileA.id);
			expect(seen).not.toContain(fileB.id);
			const { clientRows } = one(
				await tx.execute<{ clientRows: number }>(
					sql`select count(*)::int as "clientRows" from file where client_id is not null`,
				),
			);
			expect(clientRows).toBe(0);
		});
	});

	it("refuses a write for another client, a general file under a client's scope, and a client file with no scope", async () => {
		await asApp(async (tx) => {
			const { userId, a, b, fileA } = await seedFiles(tx);
			const crossInsert = await refusal(tx, (t) =>
				withClientScope(t, a.scope, (s) =>
					s.insert(file).values(fileValues(userId, { clientId: b.clientId })),
				),
			);
			expect(crossInsert.code).toBe(RLS_REFUSED);

			// A client's transaction cannot publish to every client.
			const generalUnderScope = await refusal(tx, (t) =>
				withClientScope(t, a.scope, (s) =>
					s.insert(file).values(fileValues(userId)),
				),
			);
			expect(generalUnderScope.code).toBe(RLS_REFUSED);

			const unscoped = await refusal(tx, (t) =>
				t.insert(file).values(fileValues(userId, { clientId: a.clientId })),
			);
			expect(unscoped.code).toBe(RLS_REFUSED);

			// Moving a row to another client is a cross-tenant write too. The
			// file_immutable trigger (0033) refuses it first: BEFORE triggers
			// run ahead of the policy's WITH CHECK.
			const moved = await refusal(tx, (t) =>
				withClientScope(t, a.scope, (s) =>
					s
						.update(file)
						.set({ clientId: b.clientId })
						.where(eq(file.id, fileA.id)),
				),
			);
			expect(moved.code).toBe("23001");
		});
	});

	it("gives avel_app no way around the policy", async () => {
		await asApp(async (tx) => {
			const [me] = await tx.execute<{
				user: string;
				rolsuper: boolean;
				rolbypassrls: boolean;
			}>(
				sql`select current_user as "user", rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
			);
			expect(me).toEqual({
				user: "avel_app",
				rolsuper: false,
				rolbypassrls: false,
			});

			const tables = await tx.execute<{
				relname: string;
				owner: string;
				enabled: boolean;
				forced: boolean;
			}>(
				sql`select relname, pg_get_userbyid(relowner) as owner, relrowsecurity as enabled, relforcerowsecurity as forced
				    from pg_class where relname in ('file', 'intake_files') and relkind = 'r' order by relname`,
			);
			expect(tables.map((t) => t.relname)).toEqual(["file", "intake_files"]);
			for (const t of tables) {
				expect(t.owner).not.toBe("avel_app");
				expect(t.enabled).toBe(true);
				expect(t.forced).toBe(true);
			}

			for (const statement of [
				sql`set role postgres`,
				sql`set session authorization postgres`,
				sql`alter table file disable row level security`,
				sql`alter table file no force row level security`,
				sql`alter table intake_files disable row level security`,
				sql`drop policy file_client_isolation on file`,
				sql`alter role avel_app bypassrls`,
			]) {
				const err = await refusal(tx, (t) => t.execute(statement));
				expect(err.code).toBe(RLS_REFUSED);
			}
		});
	});

	it("does not carry a scope into the next transaction on the same pooled connection", async () => {
		// No row exists yet for this client, so there is nothing to look up.
		const clientId = randomUUID() as ClientId;
		// One connection (max: 1), so the second transaction reuses the first's.
		const inside = one(
			await withClientScope(app.db, clientId, (tx) =>
				tx.execute<{ scope: string }>(
					sql`select current_setting('avel.client_id', true) as scope`,
				),
			),
		);
		expect(inside.scope).toBe(clientId);

		await asApp(async (tx) => {
			const after = one(
				await tx.execute<{ scope: string | null }>(
					sql`select current_setting('avel.client_id', true) as scope`,
				),
			);
			expect(after.scope ?? "").toBe("");
			const { userId } = await seedTenants(tx, ["Meridian"], [clientId]);
			// Reading with a spent setting must not error.
			await visibleFileIds(tx);
			// Had the scope carried over, this insert would pass its policy.
			const err = await refusal(tx, (t) =>
				t.insert(file).values(fileValues(userId, { clientId })),
			);
			expect(err.code).toBe(RLS_REFUSED);
		});
	});

	describe("intake_files", () => {
		it("attaches a client's own file or a general one to its intake, and shows the link to that client only", async () => {
			await asApp(async (tx) => {
				const { a, b, general, fileA } = await seedFiles(tx);
				await withClientScope(tx, a.scope, (t) =>
					t.insert(intakeFiles).values([
						{ intakeId: a.intakeId, fileId: fileA.id },
						{ intakeId: a.intakeId, fileId: general.id },
					]),
				);
				const links = (t: Tx) =>
					t
						.select()
						.from(intakeFiles)
						.where(eq(intakeFiles.intakeId, a.intakeId));
				expect(await withClientScope(tx, a.scope, links)).toHaveLength(2);
				expect(await withClientScope(tx, b.scope, links)).toHaveLength(0);
				expect(await links(tx)).toHaveLength(0);
			});
		});

		it("refuses another client's file on an intake, and a link to another client's intake", async () => {
			await asApp(async (tx) => {
				const { a, b, general, fileB } = await seedFiles(tx);
				const foreignFile = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s
							.insert(intakeFiles)
							.values({ intakeId: a.intakeId, fileId: fileB.id }),
					),
				);
				expect(foreignFile.code).toBe(RLS_REFUSED);
				const foreignIntake = await refusal(tx, (t) =>
					withClientScope(t, b.scope, (s) =>
						s
							.insert(intakeFiles)
							.values({ intakeId: a.intakeId, fileId: general.id }),
					),
				);
				expect(foreignIntake.code).toBe(RLS_REFUSED);
				const unscoped = await refusal(tx, (t) =>
					t
						.insert(intakeFiles)
						.values({ intakeId: a.intakeId, fileId: general.id }),
				);
				expect(unscoped.code).toBe(RLS_REFUSED);
			});
		});
	});

	describe("intake_files and engagements", () => {
		const CHECK_REFUSED = "23514";

		/** Client A with a second engagement and intake, and a file scoped to the first engagement. */
		async function seedTwoEngagements(tx: Tx) {
			const seeded = await seedFiles(tx);
			const { a, userId } = seeded;
			const engagement2 = randomUUID();
			const intake2 = randomUUID();
			await tx.insert(engagement).values({
				id: engagement2,
				clientId: a.clientId,
				name: "Second build",
				status: "active",
				startedAt: clock.now(),
				...stamp(clock),
			});
			await tx.insert(intake).values({
				id: intake2,
				engagementId: engagement2,
				status: "draft",
				sourceMd: "# Brief",
				openQuestions: [],
				...stamp(clock),
			});
			const engagementFile = fileValues(userId, {
				clientId: a.clientId,
				engagementId: a.engagementId,
			});
			await withClientScope(tx, a.scope, (t) =>
				t.insert(file).values(engagementFile),
			);
			return { ...seeded, intake2, engagementFile };
		}

		it("attaches an engagement's file only to that engagement's intakes", async () => {
			await asApp(async (tx) => {
				const { a, intake2, engagementFile } = await seedTwoEngagements(tx);
				const other = await refusal(tx, (t) =>
					withClientScope(t, a.scope, (s) =>
						s
							.insert(intakeFiles)
							.values({ intakeId: intake2, fileId: engagementFile.id }),
					),
				);
				expect(other.code).toBe(CHECK_REFUSED);
				await withClientScope(tx, a.scope, (s) =>
					s
						.insert(intakeFiles)
						.values({ intakeId: a.intakeId, fileId: engagementFile.id }),
				);
			});
		});

		it("attaches a client's file or a general one to any of that client's intakes", async () => {
			await asApp(async (tx) => {
				const { a, intake2, fileA, general } = await seedTwoEngagements(tx);
				await withClientScope(tx, a.scope, (s) =>
					s.insert(intakeFiles).values([
						{ intakeId: intake2, fileId: fileA.id },
						{ intakeId: intake2, fileId: general.id },
					]),
				);
			});
		});

		it("holds for the owner too: it is a constraint, not a policy", async () => {
			await inRollback(async (tx) => {
				const { intake2, engagementFile } = await seedTwoEngagements(tx);
				const err = await refusal(tx, (t) =>
					t
						.insert(intakeFiles)
						.values({ intakeId: intake2, fileId: engagementFile.id }),
				);
				expect(err.code).toBe(CHECK_REFUSED);
			});
		});
	});

	it("pins search_path on every function the policies and constraints call", async () => {
		await asApp(async (tx) => {
			const rows = await tx.execute<{
				proname: string;
				config: string[] | null;
			}>(
				sql`select proname, proconfig as config from pg_proc
				    where proname in ('avel_client_scope', 'intake_files_engagement_match')
				    order by proname`,
			);
			expect(rows.map((r) => r.proname)).toEqual([
				"avel_client_scope",
				"intake_files_engagement_match",
			]);
			for (const r of rows) {
				expect(r.config).toEqual(["search_path=pg_catalog, pg_temp"]);
			}
		});
	});

	describe("a file row once written", () => {
		const IMMUTABLE = "23001";

		it("keeps its scope, client, engagement and content fields, for the owner too", async () => {
			await inRollback(async (tx) => {
				const { a, b, userId, fileA, general } = await seedFiles(tx);
				const changes: [string, Partial<typeof file.$inferInsert>][] = [
					["scope", { scope: "engagement", engagementId: a.engagementId }],
					["engagement_id", { engagementId: a.engagementId }],
					["client_id", { clientId: b.clientId }],
					["sha256", { sha256: "b".repeat(64) }],
					["bytes", { bytes: 13 }],
					["mime", { mime: "text/html" }],
					["uploaded_by", { uploadedBy: userId }],
				];
				for (const [column, set] of changes) {
					const target = column === "uploaded_by" ? general.id : fileA.id;
					if (column === "uploaded_by") {
						// Another user, so the update changes something.
						const other = await seedTenants(tx, ["Other"]);
						set.uploadedBy = other.userId;
					}
					const err = await refusal(tx, (t) =>
						t.update(file).set(set).where(eq(file.id, target)),
					);
					expect(err.code, column).toBe(IMMUTABLE);
				}
			});
		});

		it("purges once: purged_at and a cleared storage_key never go back", async () => {
			await asApp(async (tx) => {
				const { a, fileA } = await seedFiles(tx);
				const purge = (t: Tx) =>
					t
						.update(file)
						.set({ purgedAt: clock.now(), storageKey: null })
						.where(eq(file.id, fileA.id));
				await withClientScope(tx, a.scope, purge);
				for (const set of [
					{ purgedAt: null, storageKey: "a".repeat(64) },
					{ storageKey: "a".repeat(64) },
					{ purgedAt: new Date(clock.now().getTime() + 1) },
				]) {
					const err = await refusal(tx, (t) =>
						withClientScope(t, a.scope, (s) =>
							s.update(file).set(set).where(eq(file.id, fileA.id)),
						),
					);
					expect(err.code, JSON.stringify(set)).toBe(IMMUTABLE);
				}
				// A rename and a soft delete still go through.
				await withClientScope(tx, a.scope, (s) =>
					s
						.update(file)
						.set({ name: "renamed.md", deletedAt: clock.now() })
						.where(eq(file.id, fileA.id)),
				);
			});
		});
	});

	describe("withClientScope", () => {
		it("refuses a second client inside a scoped transaction, and puts back an unscoped outer one", async () => {
			await asApp(async (tx) => {
				const { a: ta, b: tb } = await seedTenants(tx, ["A", "B"]);
				const a = ta.scope;
				const b = tb.scope;
				await expect(
					withClientScope(tx, a, (t) => withClientScope(t, b, async () => {})),
				).rejects.toThrow(/another client/);
				await withClientScope(tx, a, async () => {});
				const after = one(
					await tx.execute<{ scope: string | null }>(
						sql`select current_setting('avel.client_id', true) as scope`,
					),
				);
				expect(after.scope ?? "").toBe("");
			});
		});

		it("refuses a client id that is not a uuid", () => {
			expect(() =>
				withClientScope(app.db, "' or true --" as ClientId, async () => {}),
			).toThrow(/not a uuid/);
		});
	});
});
