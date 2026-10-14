import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	completionReport as completionReportWire,
	dispatch as dispatchWireSchema,
} from "../../src/contract/dispatch";
import { DISPATCH_STATUSES } from "../../src/contract/shared/status";
import { closeDb } from "../../src/db/client";
import {
	dispatchByTokenSha256,
	dispatchWire,
	insertDispatch,
	listDispatches,
	listReports,
	missionSpentUsd,
	type NewDispatch,
	reportWire,
} from "../../src/db/dispatch";
import {
	agentIdentityVersion,
	completionReport,
	dispatch,
	finding,
	rosterEntry,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { fixedClock } from "../../src/lib/clock";
import type { IdGenerator } from "../../src/lib/ids";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
	seedAgent,
	sha,
} from "./dispatch-fixtures";
import { clock, inRollback, refusal, seedMission } from "./fixtures";

async function setup(tx: Tx, ids: IdGenerator) {
	const { missionId } = await seedMission(tx, ids);
	return seedAgent(tx, ids, missionId);
}

/** Inserts the dispatch and returns the constraint that refused it. */
async function refusedBy(
	tx: Tx,
	ids: IdGenerator,
	values: NewDispatch,
): Promise<string | undefined> {
	const err = await refusal(tx, (t) =>
		t.insert(dispatch).values({ id: ids.next(), ...values, ...stamp(clock) }),
	);
	return err.constraint_name;
}

const findingBase = {
	rule: "authz.owner-check",
	subject: "PATCH /orders/:id",
	severity: "high" as const,
	class: "authorization",
	caughtBy: "zane",
	status: "open" as const,
};

describe.skipIf(!process.env.DATABASE_URL)("dispatch table", () => {
	afterAll(closeDb);

	it("takes a dispatch in every status", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			for (const status of DISPATCH_STATUSES) {
				await insertDispatchRow(tx, ids, dispatchValues(agent, ids, status));
			}
			const halted = dispatchValues(agent, ids, "halted", {
				haltReason: "operator",
			});
			await insertDispatchRow(tx, ids, halted);
		});
	});

	it("refuses each broken rule with its own CHECK", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const v = (
				status: (typeof DISPATCH_STATUSES)[number],
				over: Partial<NewDispatch>,
			) => dispatchValues(agent, ids, status, over);
			const split = (
				tokensIn: number,
				tokensOut: number,
				cacheReadTokens: number,
				cacheWriteTokens: number,
			) => ({
				tokensIn,
				tokensOut,
				cacheReadTokens,
				cacheWriteTokens,
				tokensUsed: tokensIn + tokensOut + cacheReadTokens + cacheWriteTokens,
			});
			const cases: [string, NewDispatch, string][] = [
				[
					"halted without a reason",
					v("halted", { haltReason: null }),
					"dispatch_halt_reason_iff_halted",
				],
				[
					"a reason without halting",
					v("running", { haltReason: "operator" }),
					"dispatch_halt_reason_iff_halted",
				],
				[
					"a zero estimate",
					v("queued", {
						estimatedTokens: 0,
						tokenSoftCeiling: 0,
						tokenHardCeiling: 0,
					}),
					"dispatch_estimate_positive",
				],
				[
					"a soft ceiling under the estimate",
					v("queued", { tokenSoftCeiling: 999 }),
					"dispatch_soft_ceiling_at_least_estimate",
				],
				[
					"a hard ceiling under the soft one",
					v("queued", { tokenHardCeiling: 1499 }),
					"dispatch_hard_ceiling_at_least_soft",
				],
				[
					"negative tokens_in",
					v("running", split(-1, 1, 0, 0)),
					"dispatch_token_split_nonnegative",
				],
				[
					"negative tokens_out",
					v("running", split(1, -1, 0, 0)),
					"dispatch_token_split_nonnegative",
				],
				[
					"negative cache_read_tokens",
					v("running", split(1, 0, -1, 0)),
					"dispatch_token_split_nonnegative",
				],
				[
					"negative cache_write_tokens",
					v("running", split(1, 0, 0, -1)),
					"dispatch_token_split_nonnegative",
				],
				[
					"tokens_used over the split",
					v("running", { tokensUsed: 101 }),
					"dispatch_tokens_used_is_split_sum",
				],
				[
					"tokens_used under the split",
					v("running", { tokensUsed: 99 }),
					"dispatch_tokens_used_is_split_sum",
				],
				[
					"negative spend",
					v("running", { spendUsd: "-0.000001" }),
					"dispatch_spend_nonnegative",
				],
				[
					"a zero wall clock",
					v("queued", { wallClockMinutes: 0 }),
					"dispatch_wall_clock_positive",
				],
				[
					"queued with a start",
					v("queued", { startedAt: clock.now() }),
					"dispatch_started_iff_not_queued",
				],
				[
					"running without a start",
					v("running", { startedAt: null }),
					"dispatch_started_iff_not_queued",
				],
				[
					"running with a close",
					v("running", { closedAt: clock.now() }),
					"dispatch_closed_iff_ended",
				],
				[
					"closed before it started",
					v("complete", {
						closedAt: new Date(clock.now().getTime() - 1),
					}),
					"dispatch_closed_after_started",
				],
				...(["complete", "blocked", "failed", "halted"] as const).map(
					(status): [string, NewDispatch, string] => [
						`${status} without a close`,
						v(status, { closedAt: null }),
						"dispatch_closed_iff_ended",
					],
				),
				...(
					[
						"agentIdentityVersionId",
						"agentVersionSha256",
						"skillsSha256",
						"model",
						"priceVersion",
					] as const
				).map((field): [string, NewDispatch, string] => [
					`running without ${field}`,
					v("running", { [field]: null }),
					"dispatch_frozen_once_started",
				]),
				...(
					[
						["agentVersionSha256", "dispatch_agent_version_sha256_hex"],
						["skillsSha256", "dispatch_skills_sha256_hex"],
						["tokenSha256", "dispatch_token_sha256_hex"],
						["requestSha256", "dispatch_request_sha256_hex"],
					] as const
				).flatMap(([field, constraint]) =>
					[sha("A"), "a".repeat(63), "a".repeat(65)].map(
						(bad): [string, NewDispatch, string] => [
							`${field} = ${bad}`,
							v("running", { [field]: bad }),
							constraint,
						],
					),
				),
				...[sha("A"), "a".repeat(63), "a".repeat(65)].map(
					(bad): [string, NewDispatch, string] => [
						`briefSha256 = ${bad}`,
						v("running", { briefMd: "# Brief", briefSha256: bad }),
						"dispatch_brief_sha256_hex",
					],
				),
				[
					"a brief with no hash",
					v("running", { briefMd: "# Brief", briefSha256: null }),
					"dispatch_brief_md_iff_sha256",
				],
				[
					"a brief hash with no brief",
					v("running", { briefMd: null, briefSha256: sha("c") }),
					"dispatch_brief_md_iff_sha256",
				],
			];
			for (const [name, values, constraint] of cases) {
				expect(await refusedBy(tx, ids, values), name).toBe(constraint);
			}
		});
	});

	it("leaves a queued dispatch's frozen fields unset", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const id = await insertDispatchRow(
				tx,
				ids,
				dispatchValues(agent, ids, "queued"),
			);
			const [row] = await tx.select().from(dispatch).where(eq(dispatch.id, id));
			expect(row).toMatchObject({
				agentIdentityVersionId: null,
				agentVersionSha256: null,
				skillsSha256: null,
				model: null,
				priceVersion: null,
				startedAt: null,
				closedAt: null,
			});
		});
	});

	it("requires the estimate, the ceilings, the counts and the key", async () => {
		await inRollback(async (tx) => {
			const rows = await tx.execute<{ column_name: string }>(
				sql`select column_name from information_schema.columns
					where table_schema = 'public' and table_name = 'dispatch'
					and is_nullable = 'YES' order by column_name`,
			);
			expect(rows.map((r) => r.column_name)).toEqual(
				[
					"agent_identity_version_id",
					"agent_version_sha256",
					"brief_md",
					"brief_ref",
					"brief_sha256",
					"closed_at",
					"halt_reason",
					"harness_version",
					"model",
					"price_version",
					"skills_sha256",
					"started_at",
					"token_sha256",
				].sort(),
			);
		});
	});

	it("declares exactly these foreign keys", async () => {
		await inRollback(async (tx) => {
			const rows = await tx.execute<{ conname: string; def: string }>(
				sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
					where contype = 'f' and (conrelid = 'dispatch'::regclass
					or confrelid = 'dispatch'::regclass)
					order by conname`,
			);
			expect(rows.map((r) => [r.conname, r.def])).toEqual([
				[
					"completion_report_dispatch_fk",
					"FOREIGN KEY (dispatch_id, mission_id, roster_entry_id) REFERENCES dispatch(id, mission_id, roster_entry_id)",
				],
				[
					"dispatch_agent_identity_version_id_agent_identity_version_id_fk",
					"FOREIGN KEY (agent_identity_version_id) REFERENCES agent_identity_version(id)",
				],
				[
					"dispatch_mission_id_mission_id_fk",
					"FOREIGN KEY (mission_id) REFERENCES mission(id)",
				],
				[
					"dispatch_roster_entry_id_roster_entry_id_fk",
					"FOREIGN KEY (roster_entry_id) REFERENCES roster_entry(id)",
				],
				[
					"dispatch_roster_entry_mission_fk",
					"FOREIGN KEY (roster_entry_id, mission_id) REFERENCES roster_entry(id, mission_id)",
				],
				[
					"finding_dispatch_mission_fk",
					"FOREIGN KEY (reported_by_dispatch_id, mission_id) REFERENCES dispatch(id, mission_id)",
				],
				[
					"finding_reported_by_dispatch_id_dispatch_id_fk",
					"FOREIGN KEY (reported_by_dispatch_id) REFERENCES dispatch(id)",
				],
			]);
		});
	});

	it("refuses an entry from another mission", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const other = await seedMission(tx, ids);
			expect(
				await refusedBy(
					tx,
					ids,
					dispatchValues(agent, ids, "queued", { missionId: other.missionId }),
				),
			).toBe("dispatch_roster_entry_mission_fk");
		});
	});

	it("refuses an identity version that does not exist", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			expect(
				await refusedBy(
					tx,
					ids,
					dispatchValues(agent, ids, "running", {
						agentIdentityVersionId: ids.next(),
					}),
				),
			).toBe("dispatch_agent_identity_version_id_agent_identity_version_id_fk");
		});
	});

	it("keeps token hashes unique, and start keys unique per mission", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const other = await seedAgent(
				tx,
				ids,
				(await seedMission(tx, ids)).missionId,
				"Raze",
			);
			await insertDispatchRow(
				tx,
				ids,
				dispatchValues(agent, ids, "running", {
					tokenSha256: sha("f"),
					idempotencyKey: "start-1",
				}),
			);
			expect(
				await refusedBy(
					tx,
					ids,
					dispatchValues(other, ids, "running", { tokenSha256: sha("f") }),
				),
			).toBe("dispatch_token_sha256_uq");
			expect(
				await refusedBy(
					tx,
					ids,
					dispatchValues(agent, ids, "queued", { idempotencyKey: "start-1" }),
				),
			).toBe("dispatch_mission_id_idempotency_key_uq");
			// The same key on another mission, and any number of unset hashes.
			await insertDispatchRow(
				tx,
				ids,
				dispatchValues(other, ids, "queued", { idempotencyKey: "start-1" }),
			);
			await insertDispatchRow(tx, ids, dispatchValues(agent, ids, "queued"));
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("completion_report dispatch", () => {
	afterAll(closeDb);

	it("closes exactly one dispatch, of its own mission and entry", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const second = await seedAgent(tx, ids, agent.missionId, "Leon");
			const elsewhere = await seedAgent(
				tx,
				ids,
				(await seedMission(tx, ids)).missionId,
				"Dunn",
			);
			const d = {
				id: await insertDispatchRow(
					tx,
					ids,
					dispatchValues(agent, ids, "complete"),
				),
				missionId: agent.missionId,
				rosterEntryId: agent.entryId,
			};
			const cases: [string, typeof d][] = [
				[
					"another entry of the mission",
					{ ...d, rosterEntryId: second.entryId },
				],
				[
					"another mission",
					{
						...d,
						missionId: elsewhere.missionId,
						rosterEntryId: elsewhere.entryId,
					},
				],
				["no such dispatch", { ...d, id: ids.next() }],
			];
			for (const [name, target] of cases) {
				const err = await refusal(tx, (t) =>
					t.insert(completionReport).values(reportValues(ids, target)),
				);
				expect(err.constraint_name, name).toBe("completion_report_dispatch_fk");
			}
			await tx.insert(completionReport).values(reportValues(ids, d));
			const twice = await refusal(tx, (t) =>
				t.insert(completionReport).values(reportValues(ids, d)),
			);
			expect(twice.constraint_name).toBe("completion_report_dispatch_id_uq");
		});
	});

	it("requires dispatch_id, filed_by and edge_mismatches", async () => {
		await inRollback(async (tx) => {
			const rows = await tx.execute<{
				column_name: string;
				is_nullable: string;
			}>(
				sql`select column_name, is_nullable from information_schema.columns
					where table_schema = 'public' and table_name = 'completion_report'
					and column_name in ('dispatch_id', 'filed_by', 'edge_mismatches')
					order by column_name`,
			);
			expect(rows.map((r) => [r.column_name, r.is_nullable])).toEqual([
				["dispatch_id", "NO"],
				["edge_mismatches", "NO"],
				["filed_by", "NO"],
			]);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)(
	"finding reported by a dispatch",
	() => {
		afterAll(closeDb);

		it("pairs the key with the dispatch, and keeps it unique per dispatch", async () => {
			await inRollback(async (tx, ids) => {
				const agent = await setup(tx, ids);
				const run = (status: "running") =>
					insertDispatchRow(tx, ids, dispatchValues(agent, ids, status));
				const first = await run("running");
				const second = await run("running");
				// A keyed finding carries its request hash unless a case says otherwise.
				const row = (over: Partial<typeof finding.$inferInsert>) => ({
					id: ids.next(),
					missionId: agent.missionId,
					...findingBase,
					requestSha256: over.idempotencyKey ? sha("6") : null,
					...stamp(clock),
					...over,
				});
				const cases: [Partial<typeof finding.$inferInsert>, string][] = [
					[
						{ reportedByDispatchId: first, idempotencyKey: null },
						"finding_idempotency_key_iff_dispatch",
					],
					[
						{ reportedByDispatchId: null, idempotencyKey: "f-1" },
						"finding_idempotency_key_iff_dispatch",
					],
					[
						{
							reportedByDispatchId: first,
							idempotencyKey: "f-1",
							requestSha256: null,
						},
						"finding_request_sha256_iff_key",
					],
					[{ requestSha256: sha("6") }, "finding_request_sha256_iff_key"],
					...[sha("A"), "a".repeat(63), "a".repeat(65)].map(
						(bad): [Partial<typeof finding.$inferInsert>, string] => [
							{
								reportedByDispatchId: first,
								idempotencyKey: "f-1",
								requestSha256: bad,
							},
							"finding_request_sha256_hex",
						],
					),
				];
				for (const [over, constraint] of cases) {
					const err = await refusal(tx, (t) =>
						t.insert(finding).values(row(over)),
					);
					expect(err.constraint_name, JSON.stringify(over)).toBe(constraint);
				}
				const missing = await refusal(tx, (t) =>
					t
						.insert(finding)
						.values(
							row({ reportedByDispatchId: ids.next(), idempotencyKey: "f-1" }),
						),
				);
				// Both foreign keys refuse a missing dispatch; which fires first is
				// Postgres's choice. The catalog test pins that both exist.
				expect(missing.constraint_name).toMatch(
					/^finding_(reported_by_dispatch_id_dispatch_id_fk|dispatch_mission_fk)$/,
				);
				// A real dispatch, but the finding names another mission.
				const elsewhere = await seedMission(tx, ids);
				const crossed = await refusal(tx, (t) =>
					t.insert(finding).values(
						row({
							missionId: elsewhere.missionId,
							reportedByDispatchId: first,
							idempotencyKey: "f-9",
						}),
					),
				);
				expect(crossed.constraint_name).toBe("finding_dispatch_mission_fk");
				await tx
					.insert(finding)
					.values(row({ reportedByDispatchId: first, idempotencyKey: "f-1" }));
				const again = await refusal(tx, (t) =>
					t
						.insert(finding)
						.values(
							row({ reportedByDispatchId: first, idempotencyKey: "f-1" }),
						),
				);
				expect(again.constraint_name).toBe(
					"finding_dispatch_idempotency_key_uq",
				);
				// The same key from another run, and findings code or the operator wrote.
				await tx
					.insert(finding)
					.values([
						row({ reportedByDispatchId: second, idempotencyKey: "f-1" }),
						row({}),
						row({}),
					]);
			});
		});
	},
);

describe.skipIf(!process.env.DATABASE_URL)("dispatch data layer", () => {
	afterAll(closeDb);

	async function insertAt(
		tx: Tx,
		ids: IdGenerator,
		at: string,
		values: NewDispatch,
	) {
		return insertDispatch(tx, fixedClock(at), ids, values);
	}

	it("stamps an inserted dispatch from the clock and the ids", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const at = "2026-10-13T09:00:00.000Z";
			const row = await insertAt(
				tx,
				ids,
				at,
				dispatchValues(agent, ids, "queued"),
			);
			expect(row.createdAt.toISOString()).toBe(at);
			expect(row.updatedAt.toISOString()).toBe(at);
			expect(row.id).toMatch(/^00000000-0000-4000-8000-/);
		});
	});

	it("answers exactly the contract's Dispatch, and never the token or the key", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const token = sha("9");
			const row = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "running", {
					tokenSha256: token,
					idempotencyKey: "start-secret-key",
					requestSha256: sha("4"),
					spendUsd: "1.234567",
				}),
			);
			const wire = await dispatchWire(tx, row.id);
			expect(dispatchWireSchema.strict().parse(wire)).toEqual(wire);
			expect(Object.keys(wire ?? {}).sort()).toEqual(
				Object.keys(dispatchWireSchema.shape).sort(),
			);
			const text = JSON.stringify(wire);
			expect(text).not.toContain(token);
			expect(text).not.toContain("start-secret-key");
			expect(text).not.toContain(sha("4"));
			expect(wire).not.toHaveProperty("requestSha256");
			expect(wire).not.toHaveProperty("tokenSha256");
			expect(wire).not.toHaveProperty("idempotencyKey");
			expect(wire).not.toHaveProperty("priceVersion");
			expect(wire).toMatchObject({
				id: row.id,
				missionId: agent.missionId,
				rosterEntryId: agent.entryId,
				agent: {
					templateId: agent.templateId,
					slug: agent.slug,
					name: "Kel",
					title: "Backend builder",
				},
				territory: "accounts",
				briefRef: { moduleId: "M6", requirementIds: ["R1", "R2"] },
				status: "running",
				haltReason: null,
				spendUsd: 1.234567,
				agentVersionSha256: agent.versionSha,
				agentVersionRef: `${agent.slug}@v2`,
				model: "fake-harness",
				reportId: null,
				startedAt: clock.now().toISOString(),
				closedAt: null,
				createdAt: "2026-10-13T09:00:00.000Z",
			});
			expect(await dispatchWire(tx, ids.next())).toBeNull();
		});
	});

	it("names the version a dispatch froze, not the template's latest", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const [v1] = await tx
				.select({ id: agentIdentityVersion.id })
				.from(agentIdentityVersion)
				.where(eq(agentIdentityVersion.sha256, sha("c")));
			const row = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "running", {
					agentIdentityVersionId: v1?.id,
					agentVersionSha256: sha("c"),
				}),
			);
			const queued = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "queued"),
			);
			expect((await dispatchWire(tx, row.id))?.agentVersionRef).toBe(
				`${agent.slug}@v1`,
			);
			expect((await dispatchWire(tx, queued.id))?.agentVersionRef).toBeNull();
		});
	});

	it("carries the report that closed it", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const row = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "complete"),
			);
			expect((await dispatchWire(tx, row.id))?.reportId).toBeNull();
			const report = reportValues(ids, row);
			await tx.insert(completionReport).values(report);
			expect((await dispatchWire(tx, row.id))?.reportId).toBe(report.id);
		});
	});

	it("lists a mission's dispatches newest first, filtered and paged", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const second = await seedAgent(tx, ids, agent.missionId, "Leon");
			const elsewhere = await seedAgent(
				tx,
				ids,
				(await seedMission(tx, ids)).missionId,
				"Dunn",
			);
			const at = (h: number) => `2026-10-13T0${h}:00:00.000Z`;
			const a1 = await insertAt(
				tx,
				ids,
				at(1),
				dispatchValues(agent, ids, "complete"),
			);
			const b2 = await insertAt(
				tx,
				ids,
				at(2),
				dispatchValues(second, ids, "running"),
			);
			const a3 = await insertAt(
				tx,
				ids,
				at(3),
				dispatchValues(agent, ids, "running"),
			);
			// Same instant as a3: the id breaks the tie.
			const b3 = await insertAt(
				tx,
				ids,
				at(3),
				dispatchValues(second, ids, "queued"),
			);
			await insertAt(tx, ids, at(4), dispatchValues(elsewhere, ids, "running"));

			const all = await listDispatches(tx, agent.missionId, { limit: 10 });
			expect(all.items.map((d) => d.id)).toEqual([b3.id, a3.id, b2.id, a1.id]);
			expect(all.nextCursor).toBeNull();

			const running = await listDispatches(tx, agent.missionId, {
				status: "running",
				limit: 10,
			});
			expect(running.items.map((d) => d.id)).toEqual([a3.id, b2.id]);

			const mine = await listDispatches(tx, agent.missionId, {
				rosterEntryId: agent.entryId,
				limit: 10,
			});
			expect(mine.items.map((d) => d.id)).toEqual([a3.id, a1.id]);

			const page1 = await listDispatches(tx, agent.missionId, { limit: 3 });
			expect(page1.items.map((d) => d.id)).toEqual([b3.id, a3.id, b2.id]);
			const page2 = await listDispatches(tx, agent.missionId, {
				limit: 3,
				cursor: page1.nextCursor ?? undefined,
			});
			expect(page2.items.map((d) => d.id)).toEqual([a1.id]);
			expect(page2.nextCursor).toBeNull();
			for (const d of all.items) dispatchWireSchema.strict().parse(d);
		});
	});

	it("resolves a token hash to the dispatch, its entry and its roles", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const row = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "running", { tokenSha256: sha("7") }),
			);
			const caller = await dispatchByTokenSha256(tx, sha("7"));
			expect(caller?.dispatch.id).toBe(row.id);
			expect(caller?.rosterEntry.id).toBe(agent.entryId);
			expect(caller?.roles).toEqual(["domain", "api-surface"]);
			expect(await dispatchByTokenSha256(tx, sha("8"))).toBeNull();
			// A removed agent's token stops resolving.
			await tx
				.update(rosterEntry)
				.set(remove(clock))
				.where(eq(rosterEntry.id, agent.entryId));
			expect(await dispatchByTokenSha256(tx, sha("7"))).toBeNull();
		});
	});

	it("answers exactly the contract's CompletionReport", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const row = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "complete"),
			);
			const report = reportValues(ids, row);
			await tx.insert(completionReport).values(report);
			const wire = await reportWire(tx, report.id);
			expect(completionReportWire.strict().parse(wire)).toEqual(wire);
			expect(Object.keys(wire ?? {}).sort()).toEqual(
				Object.keys(completionReportWire.shape).sort(),
			);
			expect(wire).toMatchObject({
				dispatchId: row.id,
				agentVersionRef: `${agent.slug}@v2`,
				filedBy: "agent",
				blockers: [
					{
						description: "No price table",
						workaround: "Priced at zero",
						provisioningGap: true,
					},
				],
				edgeMismatches: [
					{
						path: "src/contract/dispatch.ts",
						readSha256: sha("1"),
						writtenSha256: sha("3"),
						producerDispatchId: row.id,
					},
				],
			});
			expect(await reportWire(tx, ids.next())).toBeNull();
		});
	});

	it("gives a report no ref when its hash is not the dispatch's version", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const row = await insertAt(
				tx,
				ids,
				"2026-10-13T09:00:00.000Z",
				dispatchValues(agent, ids, "complete"),
			);
			const report = reportValues(ids, row, {
				agentVersionSha256: sha("0"),
				versionSource: "reconstructed",
			});
			await tx.insert(completionReport).values(report);
			expect((await reportWire(tx, report.id))?.agentVersionRef).toBeNull();
		});
	});

	it("lists a mission's live reports newest first", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			const reports = [];
			for (const h of [1, 2, 3]) {
				const at = `2026-10-13T0${h}:00:00.000Z`;
				const row = await insertAt(
					tx,
					ids,
					at,
					dispatchValues(agent, ids, "complete"),
				);
				const report = reportValues(ids, row, stamp(fixedClock(at)));
				await tx.insert(completionReport).values(report);
				reports.push(report.id);
			}
			await tx
				.update(completionReport)
				.set(remove(clock))
				.where(eq(completionReport.id, reports[1] as string));
			const page1 = await listReports(tx, agent.missionId, { limit: 1 });
			expect(page1.items.map((r) => r.id)).toEqual([reports[2]]);
			const page2 = await listReports(tx, agent.missionId, {
				limit: 1,
				cursor: page1.nextCursor ?? undefined,
			});
			expect(page2.items.map((r) => r.id)).toEqual([reports[0]]);
			expect(page2.nextCursor).toBeNull();
			expect(await reportWire(tx, reports[1] as string)).toBeNull();
		});
	});

	it("sums a mission's spend exactly, over every status", async () => {
		await inRollback(async (tx, ids) => {
			const agent = await setup(tx, ids);
			expect(await missionSpentUsd(tx, agent.missionId)).toBe(0);
			const other = await seedAgent(
				tx,
				ids,
				(await seedMission(tx, ids)).missionId,
				"Dunn",
			);
			for (const [status, spendUsd] of [
				["running", "1.1"],
				["halted", "2.2"],
				["failed", "0.000003"],
			] as const) {
				await insertDispatchRow(
					tx,
					ids,
					dispatchValues(agent, ids, status, { spendUsd }),
				);
			}
			await insertDispatchRow(
				tx,
				ids,
				dispatchValues(other, ids, "running", { spendUsd: "5" }),
			);
			// Summed as floats, in any order, these give 3.3000030000000002.
			expect(await missionSpentUsd(tx, agent.missionId)).toBe(3.300003);
		});
	});
});
