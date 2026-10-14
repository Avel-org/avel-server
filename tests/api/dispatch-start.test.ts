import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	agentTemplate,
	dispatch,
	mission,
	missionSkills,
	roleSkills,
	rosterEntry,
	skill,
	skillSource,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { PRICE_VERSION } from "../../src/lib/prices";
import { sha256Hex } from "../../src/lib/tokens";
import { DEFAULT_PRICE_BOOK } from "../../src/runner/budget";
import { FakeHarness } from "../../src/runner/harness";
import { skillsSha256 } from "../../src/runner/skills";
import { dispatchValues, insertDispatchRow } from "../db/dispatch-fixtures";
import { bearer, seedIds } from "./agent-fixtures";
import {
	activeMission,
	expectReportsMatchDispatches,
	expectSystemReport,
	lifeOf,
	type Mission,
	pricedBook,
	queued,
	read,
	reportsOf,
	row,
	start,
	started,
} from "./runner-fixtures";
import { clock, withApi } from "./support";

async function failure(res: Response, status: number) {
	expect(res.status).toBe(status);
	return errorEnvelope.parse(await res.json()).error;
}

async function refusedWith(res: Response, reason: string) {
	const error = await failure(res, 422);
	expect(error.code).toBe("PRECONDITION_FAILED");
	expect(error.details).toMatchObject({ reason });
	return error.details;
}

const halt =
	(call: (p: string, i?: { method?: string }) => Promise<Response>) =>
	(id: string) =>
		call(`/api/dispatches/${id}/halt`, { method: "POST" });

/** Nothing about a refused start was written: still queued, no hash, no activity. */
async function expectUntouched(tx: Tx, id: string) {
	const d = await row(tx, id);
	expect(d).toMatchObject({
		status: "queued",
		startedAt: null,
		tokenSha256: null,
		agentIdentityVersionId: null,
		skillsSha256: null,
		model: null,
		priceVersion: null,
	});
	expect(
		await tx.select().from(activityLog).where(eq(activityLog.entityId, id)),
	).toEqual([]);
}

describe.skipIf(!process.env.DATABASE_URL)(
	"POST /api/dispatches/:id/start",
	() => {
		afterAll(closeDb);

		it("starts a queued dispatch: freezes the run, hands the token to the harness only, and logs it", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const id = await queued(h.tx, m);
					const res = await start(h, id);
					expect(res.status).toBe(200);
					const text = await res.text();
					const wire = read.parse(JSON.parse(text)).data;
					expect(wire).toMatchObject({
						id,
						status: "running",
						haltReason: null,
						agentVersionSha256: m.agent.versionSha,
						agentVersionRef: `${m.agent.slug}@v2`,
						skillsSha256: skillsSha256([]),
						model: "fake-harness",
						reportId: null,
						startedAt: clock.now().toISOString(),
						closedAt: null,
					});

					const token = harness.tokenFor(id);
					expect(token).toMatch(/^avl_dsp_[0-9a-f]{64}$/);
					const d = await row(h.tx, id);
					expect(d).toMatchObject({
						agentIdentityVersionId: m.agent.versionId,
						priceVersion: PRICE_VERSION,
						tokenSha256: sha256Hex(token ?? ""),
					});
					expect(text).not.toContain((token ?? "").slice(8));

					const logs = await h.logRows(id);
					expect(logs).toHaveLength(1);
					expect(logs[0]).toMatchObject({
						actorKind: "operator",
						actorUserId: await h.operatorId(),
						action: "dispatch.started",
						missionId: m.missionId,
						engagementId: m.engagementId,
						requestId: res.headers.get("x-request-id"),
					});
					expect(logs[0]?.payload).toEqual({
						agentVersionSha256: m.agent.versionSha,
						skillsSha256: skillsSha256([]),
						model: "fake-harness",
						priceVersion: PRICE_VERSION,
					});
					expect(JSON.stringify(logs)).not.toContain((token ?? "").slice(8));

					// The token the harness holds is the agent's.
					const own = await h.call("/api/agent/dispatch", {
						headers: bearer(token ?? ""),
					});
					expect(own.status).toBe(200);
					expect(read.parse(await own.json()).data.id).toBe(id);
				},
				{ harness },
			);
		});

		it("freezes the price version the book starts under", async () => {
			const prices = pricedBook();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const id = await queued(h.tx, m);
					expect((await start(h, id)).status).toBe(200);
					expect((await row(h.tx, id)).priceVersion).toBe("test-prices");
				},
				{ prices },
			);
		});

		it("hashes the mission's stack and domain skills for the agent's roles, never its role skills", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const ids = seedIds(h.ns);
				const m = await activeMission(h.tx, ids);
				const sourceId = ids.next();
				await h.tx.insert(skillSource).values({
					id: sourceId,
					name: `Source ${h.ns}`,
					kind: "internal",
					...stamp(clock),
				});
				const newSkill = async (
					slug: string,
					layer: "role" | "stack" | "domain",
					recommendedFor: Array<"domain" | "schema">,
					content: string,
				) => {
					const skillId = ids.next();
					await h.tx.insert(skill).values({
						id: skillId,
						slug: `${h.ns}-${slug}`,
						name: slug,
						description: "When to use it.",
						contentMd: "#",
						layer,
						type: "knowledge",
						recommendedFor,
						sourceId,
						contentSha256: content.repeat(64),
						status: "approved",
						version: 1,
						...stamp(clock),
					});
					return skillId;
				};
				const stack = await newSkill("drizzle", "stack", ["domain"], "1");
				const domain = await newSkill("booking", "domain", ["domain"], "2");
				const elsewhere = await newSkill("pg", "stack", ["schema"], "3");
				const role = await newSkill("props", "role", ["domain"], "4");
				for (const skillId of [stack, domain, elsewhere]) {
					await h.tx
						.insert(missionSkills)
						.values({ missionId: m.missionId, skillId, source: "manual" });
				}
				await h.tx.insert(roleSkills).values({ role: "domain", skillId: role });
				// A deleted skill still attached, and another mission's skill.
				const gone = await newSkill("gone", "stack", ["domain"], "5");
				await h.tx
					.insert(missionSkills)
					.values({ missionId: m.missionId, skillId: gone, source: "manual" });
				await h.tx.update(skill).set(remove(clock)).where(eq(skill.id, gone));
				const other = await activeMission(h.tx, ids);
				const theirs = await newSkill("theirs", "stack", ["domain"], "6");
				await h.tx.insert(missionSkills).values({
					missionId: other.missionId,
					skillId: theirs,
					source: "manual",
				});

				const id = await queued(h.tx, m);
				const wire = read.parse(await (await start(h, id)).json()).data;
				expect(wire.skillsSha256).toBe(
					skillsSha256([
						{ slug: `${h.ns}-drizzle`, contentSha256: "1".repeat(64) },
						{ slug: `${h.ns}-booking`, contentSha256: "2".repeat(64) },
					]),
				);
			});
		});

		it("refuses in order: mission, entry, identity, price, spend, harness; and writes nothing", async () => {
			const harness = new FakeHarness();
			const prices = {
				current: PRICE_VERSION,
				tables: {} as Record<
					string,
					(typeof DEFAULT_PRICE_BOOK.tables)[string]
				>,
			};
			await withApi(
				async (h) => {
					await h.signIn();
					const ids = seedIds(h.ns);
					const m = await activeMission(h.tx, ids, "5.00");
					const id = await queued(h.tx, m);
					// Every precondition broken at once; each fix exposes the next.
					await h.tx
						.update(mission)
						.set({ status: "draft" })
						.where(eq(mission.id, m.missionId));
					await h.tx
						.update(rosterEntry)
						.set({ active: false })
						.where(eq(rosterEntry.id, m.agent.entryId));
					await h.tx
						.update(agentTemplate)
						.set({ roles: ["foundations"] })
						.where(eq(agentTemplate.id, m.agent.templateId));
					await insertDispatchRow(
						h.tx,
						ids,
						dispatchValues(m.agent, ids, "halted", { spendUsd: "5.000000" }),
					);
					harness.accepting = false;

					const at = { dispatchId: id, missionId: m.missionId };
					const entryAt = { ...at, rosterEntryIds: [m.agent.entryId] };
					expect(
						await refusedWith(await start(h, id), "mission_not_active"),
					).toEqual({ reason: "mission_not_active", ...at });
					await h.tx
						.update(mission)
						.set({ status: "active" })
						.where(eq(mission.id, m.missionId));
					expect(
						await refusedWith(await start(h, id), "roster_entry_inactive"),
					).toEqual({ reason: "roster_entry_inactive", ...entryAt });
					await h.tx
						.update(rosterEntry)
						.set({ active: true })
						.where(eq(rosterEntry.id, m.agent.entryId));
					expect(
						await refusedWith(await start(h, id), "agent_identity_missing"),
					).toEqual({ reason: "agent_identity_missing", ...entryAt });
					await h.tx
						.update(agentTemplate)
						.set({ roles: ["domain", "api-surface"] })
						.where(eq(agentTemplate.id, m.agent.templateId));
					expect(
						await refusedWith(await start(h, id), "model_price_unknown"),
					).toEqual({
						reason: "model_price_unknown",
						...at,
						model: "fake-harness",
					});
					prices.tables = { ...DEFAULT_PRICE_BOOK.tables };
					expect(
						await refusedWith(await start(h, id), "spend_ceiling_reached"),
					).toEqual({ reason: "spend_ceiling_reached", ...at });
					await h.tx
						.update(mission)
						.set({ spendCeilingUsd: "5.01" })
						.where(eq(mission.id, m.missionId));
					expect(
						await refusedWith(await start(h, id), "harness_unavailable"),
					).toEqual({ reason: "harness_unavailable", ...at });
					await expectUntouched(h.tx, id);
					expect(harness.tokenFor(id)).toBeUndefined();

					harness.accepting = true;
					expect((await start(h, id)).status).toBe(200);
				},
				{ harness, prices },
			);
		});

		it("refuses a model the book does not price, naming it", async () => {
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const id = await queued(h.tx, m);
					const details = await refusedWith(
						await start(h, id),
						"model_price_unknown",
					);
					expect(details).toMatchObject({ model: "unpriced" });
					await expectUntouched(h.tx, id);
				},
				{ harness: new FakeHarness({ model: "unpriced" }) },
			);
		});

		it("refuses a removed roster entry as inactive", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const id = await queued(h.tx, m);
				await h.tx
					.update(rosterEntry)
					.set(remove(clock))
					.where(eq(rosterEntry.id, m.agent.entryId));
				await refusedWith(await start(h, id), "roster_entry_inactive");
				await expectUntouched(h.tx, id);
			});
		});

		it("refuses spend over the ceiling too, not only at it", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const ids = seedIds(h.ns);
				const m = await activeMission(h.tx, ids, "5.00");
				await insertDispatchRow(
					h.tx,
					ids,
					dispatchValues(m.agent, ids, "failed", { spendUsd: "7.500000" }),
				);
				const id = await queued(h.tx, m);
				await refusedWith(await start(h, id), "spend_ceiling_reached");
			});
		});

		it("refuses a dispatch that is not queued first, even on a draft mission", async () => {
			const harness = new FakeHarness();
			harness.accepting = false;
			await withApi(
				async (h) => {
					await h.signIn();
					const ids = seedIds(h.ns);
					const m = await activeMission(h.tx, ids);
					await h.tx
						.update(mission)
						.set({ status: "draft" })
						.where(eq(mission.id, m.missionId));
					for (const status of [
						"running",
						"complete",
						"blocked",
						"failed",
						"halted",
					] as const) {
						const id = await insertDispatchRow(
							h.tx,
							ids,
							dispatchValues(m.agent, ids, status),
						);
						const before = await row(h.tx, id);
						expect(
							await refusedWith(await start(h, id), "dispatch_not_queued"),
							status,
						).toEqual({
							reason: "dispatch_not_queued",
							dispatchId: id,
							missionId: m.missionId,
						});
						expect(await row(h.tx, id)).toEqual(before);
					}
				},
				{ harness },
			);
		});

		it("answers 404 for an unknown dispatch, or one on a hidden mission", async () => {
			await withApi(async (h) => {
				await h.signIn();
				const m = await activeMission(h.tx, seedIds(h.ns));
				const id = await queued(h.tx, m);
				const unknown = "00000000-0000-4000-8000-00000000ffff";
				expect((await failure(await start(h, unknown), 404)).code).toBe(
					"NOT_FOUND",
				);
				await h.tx
					.update(mission)
					.set(remove(clock))
					.where(eq(mission.id, m.missionId));
				expect((await failure(await start(h, id), 404)).code).toBe("NOT_FOUND");
				expect((await failure(await halt(h.call)(id), 404)).code).toBe(
					"NOT_FOUND",
				);
				await expectUntouched(h.tx, id);
			});
		});
	},
);

describe.skipIf(!process.env.DATABASE_URL)(
	"POST /api/dispatches/:id/halt",
	() => {
		afterAll(closeDb);

		it("halts a running dispatch as the operator; the system files the report; the token dies", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(h, harness, m);
					expect(
						(
							await h.call("/api/agent/dispatch", {
								headers: bearer(run.token),
							})
						).status,
					).toBe(200);

					const res = await halt(h.call)(run.id);
					expect(res.status).toBe(200);
					const wire = read.parse(await res.json()).data;
					const { r } = await expectSystemReport(h.tx, run.id);
					expect(wire).toMatchObject({
						status: "halted",
						haltReason: "operator",
						closedAt: clock.now().toISOString(),
						reportId: r.id,
					});
					expect(r).toMatchObject({ status: "halted", haltReason: "operator" });
					expect(harness.stopped).toEqual([run.id]);

					const operatorId = await h.operatorId();
					const life = await lifeOf(h.tx, run.id);
					expect(
						life.map((a) => [a.action, a.actorKind, a.actorUserId]),
					).toEqual([
						["dispatch.started", "operator", operatorId],
						["dispatch.halted", "operator", operatorId],
						["completion_report.filed", "system", null],
						["dispatch.closed", "system", null],
					]);
					expect(life.slice(1).map((a) => a.payload)).toEqual([
						{ reason: "operator" },
						{ dispatchId: run.id, status: "halted", filedBy: "system" },
						{ status: "halted", reportId: r.id },
					]);
					for (const a of life.slice(1)) {
						expect(a.requestId).toBe(res.headers.get("x-request-id"));
						expect(a.missionId).toBe(m.missionId);
					}

					const dead = await failure(
						await h.call("/api/agent/dispatch", { headers: bearer(run.token) }),
						401,
					);
					expect(dead.code).toBe("DISPATCH_CLOSED");
					await expectReportsMatchDispatches(h.tx, [m.missionId]);
				},
				{ harness },
			);
		});

		it("refuses anything not running (dispatch_not_running), and writes nothing", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const ids = seedIds(h.ns);
					const m = await activeMission(h.tx, ids);
					for (const status of [
						"queued",
						"complete",
						"blocked",
						"failed",
						"halted",
					] as const) {
						const id = await insertDispatchRow(
							h.tx,
							ids,
							dispatchValues(m.agent, ids, status),
						);
						const before = await row(h.tx, id);
						expect(
							await refusedWith(await halt(h.call)(id), "dispatch_not_running"),
						).toEqual({
							reason: "dispatch_not_running",
							dispatchId: id,
							missionId: m.missionId,
						});
						expect(await row(h.tx, id)).toEqual(before);
						expect(await reportsOf(h.tx, id)).toEqual([]);
					}
					expect(harness.stopped).toEqual([]);
				},
				{ harness },
			);
		});
	},
);

describe.skipIf(!process.env.DATABASE_URL)(
	"POST /api/missions/:id/halt",
	() => {
		afterAll(closeDb);

		it("halts the mission's running dispatches as the operator, in the same transaction", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const ids = seedIds(h.ns);
					const m: Mission = await activeMission(h.tx, ids);
					const a = await started(h, harness, m);
					const b = await started(h, harness, m);
					const waiting = await queued(h.tx, m);
					const done = await insertDispatchRow(
						h.tx,
						ids,
						dispatchValues(m.agent, ids, "complete"),
					);
					const other = await activeMission(h.tx, ids);
					const elsewhere = await started(h, harness, other);

					const res = await h.call(`/api/missions/${m.missionId}/halt`, {
						method: "POST",
					});
					expect(res.status).toBe(200);
					const operatorId = await h.operatorId();
					for (const run of [a, b]) {
						const { d } = await expectSystemReport(h.tx, run.id);
						expect([d.status, d.haltReason]).toEqual(["halted", "operator"]);
						const halted = (await lifeOf(h.tx, run.id)).find(
							(x) => x.action === "dispatch.halted",
						);
						expect(halted).toMatchObject({
							actorKind: "operator",
							actorUserId: operatorId,
							requestId: res.headers.get("x-request-id"),
						});
						expect(
							(
								await h.call("/api/agent/dispatch", {
									headers: bearer(run.token),
								})
							).status,
						).toBe(401);
					}
					expect(harness.stopped.sort()).toEqual([a.id, b.id].sort());
					expect((await row(h.tx, waiting)).status).toBe("queued");
					expect((await row(h.tx, done)).status).toBe("complete");
					expect((await row(h.tx, elsewhere.id)).status).toBe("running");
					const [mrow] = await h.tx
						.select({ status: mission.status })
						.from(mission)
						.where(eq(mission.id, m.missionId));
					expect(mrow?.status).toBe("halted");
					await expectReportsMatchDispatches(h.tx, [
						m.missionId,
						other.missionId,
					]);
				},
				{ harness },
			);
		});

		it("rolls the dispatch halts back with a refused mission halt", async () => {
			const harness = new FakeHarness();
			await withApi(
				async (h) => {
					await h.signIn();
					const m = await activeMission(h.tx, seedIds(h.ns));
					const run = await started(h, harness, m);
					await h.tx
						.update(mission)
						.set({ status: "shipped" })
						.where(eq(mission.id, m.missionId));
					await refusedWith(
						await h.call(`/api/missions/${m.missionId}/halt`, {
							method: "POST",
						}),
						"mission_not_active",
					);
					expect((await row(h.tx, run.id)).status).toBe("running");
					expect(harness.stopped).toEqual([]);
					const [still] = await h.tx
						.select({ status: dispatch.status })
						.from(dispatch)
						.where(eq(dispatch.id, run.id));
					expect(still?.status).toBe("running");
				},
				{ harness },
			);
		});
	},
);
