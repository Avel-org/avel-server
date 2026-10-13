import { afterAll, describe, expect, it } from "vitest";
import {
	errorEnvelope,
	exportTargetKind,
	MISSION_STATUSES,
	missionDetail,
	missionListEnvelope,
	missionOrigin,
	missionStatusCounts,
	successEnvelope,
} from "../../src/contract";
import {
	activityLog,
	agentTemplate,
	client,
	engagement,
	exportTable,
	exportTargetKind as exportTargetKindEnum,
	mission,
	missionOrigin as missionOriginEnum,
	playbook,
	rosterEntry,
	rosterPreset,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import { clock, closeApi, prefixedIds, statements, withApi } from "./support";

const url = process.env.DATABASE_URL;
const at = (minutes: number) =>
	new Date(clock.now().getTime() + minutes * 60_000);

/** Statements that touch the mission tables. Session and user lookups for auth are left out. */
function missionStatements(from: number): string[] {
	return statements
		.slice(from)
		.filter((q) => /from "mission"|from "activity_log"/.test(q));
}

type Harness = {
	tx: Tx;
	ids: IdGenerator;
	call: (path: string) => Promise<Response>;
	anonymous: (path: string) => Promise<Response>;
	operatorId: string;
};

/**
 * withApi on the counting connection, signed in, with seed ids under their
 * own prefix so they never meet the app's sequential ids.
 */
async function withMissions(fn: (h: Harness) => Promise<void>) {
	await withApi(
		async (api) => {
			await api.signIn();
			await fn({
				tx: api.tx,
				ids: prefixedIds("dddddddd"),
				operatorId: await api.operatorId(),
				call: (path) => api.call(path),
				anonymous: async (path) => api.app.request(path),
			});
		},
		{ countStatements: true },
	);
}

/** Seeds rows straight into the transaction. */
function seeder(tx: Tx, ids: IdGenerator) {
	return {
		async client(
			name: string,
			extra: Partial<typeof client.$inferInsert> = {},
		) {
			const id = ids.next();
			await tx
				.insert(client)
				.values({ id, name, status: "active", ...stamp(clock), ...extra });
			return id;
		},
		async engagement(
			clientId: string,
			name: string,
			extra: Partial<typeof engagement.$inferInsert> = {},
		) {
			const id = ids.next();
			await tx.insert(engagement).values({
				id,
				clientId,
				name,
				status: "active",
				startedAt: clock.now(),
				...stamp(clock),
				...extra,
			});
			return id;
		},
		async mission(
			extra: Partial<typeof mission.$inferInsert> & {
				engagementId?: string | null;
			},
		) {
			const id = ids.next();
			await tx.insert(mission).values({
				id,
				origin: extra.engagementId ? "client" : "internal",
				type: "full-build",
				brief: {},
				sprintN: 1,
				status: "active",
				cut: "vertical",
				cutSource: "derived",
				repoUrl: "https://github.com/meridian-co/app",
				...stamp(clock),
				...extra,
				engagementId: extra.engagementId ?? null,
			});
			return id;
		},
		async export(
			missionId: string,
			status: typeof exportTable.$inferInsert.status,
			createdAt: Date,
			statusChangedAt: Date = createdAt,
		) {
			const id = ids.next();
			await tx.insert(exportTable).values({
				id,
				missionId,
				sprintN: 1,
				idempotencyKey: id,
				targetKind: "zip",
				status,
				dryRun: status === "previewed",
				createdAt,
				updatedAt: createdAt,
				statusChangedAt,
			});
			return id;
		},
		async activity(missionId: string, when: Date, actorUserId?: string) {
			await tx.insert(activityLog).values({
				id: ids.next(),
				at: when,
				actorKind: actorUserId ? "operator" : "system",
				actorUserId: actorUserId ?? null,
				action: "engagement.updated",
				entityType: "engagement",
				entityId: missionId,
				missionId,
				requestId: "seed",
				payload: {},
			});
		},
	};
}

async function listOf(call: Harness["call"], query: string) {
	const res = await call(`/api/missions?${query}`);
	expect(res.status, await res.clone().text()).toBe(200);
	return missionListEnvelope.parse(await res.json());
}

/** Walks every page with `limit`, returning the ids in order. */
async function walk(call: Harness["call"], query: string, limit: number) {
	const ids: string[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 50; i++) {
		const page = await listOf(
			call,
			`${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
		);
		ids.push(...page.data.map((m) => m.id));
		cursor = page.meta.nextCursor;
		if (!cursor) return ids;
	}
	throw new Error("pagination never ended");
}

describe("mission contract vocabulary", () => {
	it("matches the pgEnums exactly", () => {
		expect(missionOrigin.options).toEqual(missionOriginEnum.enumValues);
		expect(exportTargetKind.options).toEqual(exportTargetKindEnum.enumValues);
	});

	it("has a count key for every mission status", () => {
		expect(Object.keys(missionStatusCounts.shape)).toEqual([
			...MISSION_STATUSES,
		]);
	});
});

describe.skipIf(!url)("/api/missions", () => {
	afterAll(closeApi);

	it("never lists internal and client missions together, and requires origin", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const e = await s.engagement(await s.client("Meridian"), "App build");
			const c1 = await s.mission({ engagementId: e });
			const c2 = await s.mission({ engagementId: e });
			const internal = await s.mission({ engagementId: null });

			const clients = await listOf(call, "origin=client");
			expect(clients.data.map((m) => m.id).sort()).toEqual([c1, c2].sort());
			expect(clients.data.every((m) => m.origin === "client")).toBe(true);
			expect(clients.data[0]?.client?.name).toBe("Meridian");
			expect(clients.meta.counts.byStatus.active).toBe(2);

			const internals = await listOf(call, "origin=internal");
			expect(internals.data.map((m) => m.id)).toEqual([internal]);
			expect(internals.data[0]).toMatchObject({
				client: null,
				engagement: null,
			});
			expect(internals.meta.counts.byStatus.active).toBe(1);

			const missing = await call("/api/missions");
			expect(missing.status).toBe(400);
			expect(errorEnvelope.parse(await missing.json()).error.code).toBe(
				"VALIDATION_FAILED",
			);
		});
	});

	describe("sorts, each with a cursor that reaches every mission once, in order", () => {
		it("lastActivity: newest activity first, missions without activity last, ties by id", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const m1 = await s.mission({});
				const m2 = await s.mission({});
				const m3 = await s.mission({});
				const quiet1 = await s.mission({});
				const quiet2 = await s.mission({});
				await s.activity(m1, at(1));
				await s.activity(m2, at(3));
				await s.activity(m3, at(2));
				await s.activity(m3, at(1));
				const expected = [m2, m3, m1, quiet2, quiet1];
				expect(await walk(call, "origin=internal", 1)).toEqual(expected);
				expect(
					await walk(call, "origin=internal&sort=lastActivity", 2),
				).toEqual(expected);
				expect(await walk(call, "origin=internal", 100)).toEqual(expected);
			});
		});

		it("sprint: highest sprint first, ties by id", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const a = await s.mission({ sprintN: 3 });
				const b = await s.mission({ sprintN: 1 });
				const c = await s.mission({ sprintN: 2 });
				const d = await s.mission({ sprintN: 2 });
				const expected = [a, d, c, b];
				expect(await walk(call, "origin=internal&sort=sprint", 1)).toEqual(
					expected,
				);
				expect(await walk(call, "origin=internal&sort=sprint", 3)).toEqual(
					expected,
				);
			});
		});

		it("client: client name ascending, case-insensitive, ties by id", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const zeta = await s.engagement(await s.client("Zeta"), "Z");
				const alpha = await s.engagement(await s.client("alpha"), "A");
				const beta = await s.engagement(await s.client("Beta"), "B");
				const z1 = await s.mission({ engagementId: zeta });
				const a1 = await s.mission({ engagementId: alpha });
				const b1 = await s.mission({ engagementId: beta });
				const a2 = await s.mission({ engagementId: alpha });
				const expected = [a1, a2, b1, z1];
				expect(await walk(call, "origin=client&sort=client", 1)).toEqual(
					expected,
				);
				expect(await walk(call, "origin=client&sort=client", 3)).toEqual(
					expected,
				);
			});
		});
	});

	it("refuses a cursor from another sort, and a forged one, with 400", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			for (let i = 0; i < 3; i++) await s.mission({ sprintN: i });
			const first = await listOf(call, "origin=internal&sort=sprint&limit=1");
			const cursor = first.meta.nextCursor;
			expect(cursor).not.toBeNull();

			for (const sort of ["lastActivity", "client"]) {
				const res = await call(
					`/api/missions?origin=internal&sort=${sort}&cursor=${cursor}`,
				);
				expect(res.status, sort).toBe(400);
				expect(errorEnvelope.parse(await res.json()).error.code).toBe(
					"VALIDATION_FAILED",
				);
			}
			// A lastActivity cursor at a mission with no activity carries null,
			// which is also a well-formed client-sort value: only the cursor's
			// own sort can refuse it.
			const quiet = await listOf(
				call,
				"origin=internal&sort=lastActivity&limit=1",
			);
			const nullValued = quiet.meta.nextCursor;
			expect(
				JSON.parse(
					Buffer.from(nullValued ?? "", "base64url").toString("utf8"),
				)[1],
			).toBeNull();
			const crossed = await call(
				`/api/missions?origin=internal&sort=client&cursor=${nullValued}`,
			);
			expect(crossed.status).toBe(400);

			const forged = Buffer.from(
				JSON.stringify(["sprint", "three", "-".repeat(36)]),
			).toString("base64url");
			expect(
				(
					await call(
						`/api/missions?origin=internal&sort=sprint&cursor=${forged}`,
					)
				).status,
			).toBe(400);
		});
	});

	it("counts every status, zeros included, ignoring the status filter but honoring q and includeArchived", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const meridian = await s.engagement(await s.client("Meridian"), "App");
			const acme = await s.engagement(await s.client("Acme"), "Site");
			await s.mission({ engagementId: meridian, status: "active" });
			await s.mission({ engagementId: meridian, status: "active" });
			await s.mission({ engagementId: meridian, status: "halted" });
			await s.mission({ engagementId: meridian, status: "archived" });
			await s.mission({ engagementId: acme, status: "draft" });

			const all = await listOf(call, "origin=client&status=halted");
			expect(all.data).toHaveLength(1);
			expect(all.meta.counts.byStatus).toEqual({
				draft: 1,
				active: 2,
				halted: 1,
				shipped: 0,
				archived: 0,
			});

			const withArchived = await listOf(
				call,
				"origin=client&includeArchived=true",
			);
			expect(withArchived.meta.counts.byStatus.archived).toBe(1);
			expect(withArchived.data).toHaveLength(5);

			const hiddenEvenIfAsked = await listOf(
				call,
				"origin=client&status=archived",
			);
			expect(hiddenEvenIfAsked.data).toHaveLength(0);

			const scoped = await listOf(call, "origin=client&q=acme");
			expect(scoped.meta.counts.byStatus).toEqual({
				draft: 1,
				active: 0,
				halted: 0,
				shipped: 0,
				archived: 0,
			});

			const multi = await listOf(
				call,
				"origin=client&status=active&status=draft",
			);
			expect(multi.data.map((m) => m.status).sort()).toEqual([
				"active",
				"active",
				"draft",
			]);
			// ts-rest's own client sends arrays indexed; both forms must agree.
			const indexed = await listOf(
				call,
				"origin=client&status%5B0%5D=active&status%5B1%5D=draft",
			);
			expect(indexed.data.map((m) => m.id).sort()).toEqual(
				multi.data.map((m) => m.id).sort(),
			);
			const unencoded = await listOf(
				call,
				"origin=client&status[0]=active&status[1]=draft",
			);
			expect(unencoded.data).toHaveLength(3);
		});
	});

	it("searches client name, engagement name and type case-insensitively, with LIKE metacharacters literal", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const e1 = await s.engagement(
				await s.client("Meridian Health"),
				"Patient portal",
			);
			const e2 = await s.engagement(
				await s.client("Acme"),
				"100% uptime_sprint",
			);
			const byClient = await s.mission({
				engagementId: e1,
				type: "full-build",
			});
			const byEngagement = await s.mission({ engagementId: e2, type: "audit" });
			const byType = await s.mission({ engagementId: e1, type: "Discovery" });

			const q = async (term: string) =>
				(await listOf(call, `origin=client&q=${encodeURIComponent(term)}`)).data
					.map((m) => m.id)
					.sort();
			expect(await q("MERIDIAN")).toEqual([byClient, byType].sort());
			expect(await q("portal")).toEqual([byClient, byType].sort());
			expect(await q("discov")).toEqual([byType]);
			expect(await q("100%")).toEqual([byEngagement]);
			expect(await q("%")).toEqual([byEngagement]);
			expect(await q("_")).toEqual([byEngagement]);
			// Unescaped, "h_a" would match "Health"; escaped it matches nothing.
			expect(await q("h_a")).toEqual([]);
		});
	});

	it("scopes to one client, and to one template, with counts and total following", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const meridian = await s.client("Meridian Health");
			const e1 = await s.engagement(meridian, "Portal");
			const e2 = await s.engagement(meridian, "Billing");
			const acme = await s.engagement(await s.client("Acme"), "Site");
			const sha = "0123456789abcdef0123456789abcdef01234567";
			const booked = {
				templateRef: "template-booking",
				templateVersion: sha,
			};
			const a = await s.mission({ engagementId: e1, ...booked });
			const b = await s.mission({ engagementId: e2, status: "draft" });
			const c = await s.mission({ engagementId: acme, ...booked });
			const internal = await s.mission({ engagementId: null, ...booked });

			const forClient = await listOf(
				call,
				`origin=client&clientId=${meridian}`,
			);
			expect(forClient.data.map((m) => m.id).sort()).toEqual([a, b].sort());
			expect(forClient.meta.total).toBe(2);
			expect(forClient.meta.counts.byStatus).toMatchObject({
				active: 1,
				draft: 1,
			});

			const idsFor = async (query: string) =>
				(await listOf(call, query)).data.map((m) => m.id).sort();
			expect(
				await idsFor("origin=client&templateRef=template-booking"),
			).toEqual([a, c].sort());
			expect(
				await idsFor("origin=internal&templateRef=template-booking"),
			).toContain(internal);
			expect(
				await idsFor(
					`origin=client&clientId=${meridian}&templateRef=template-booking`,
				),
			).toEqual([a]);
		});
	});

	it("derives needsYou from the last export only, and counts it", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const previewed = await s.mission({});
			const prOpen = await s.mission({});
			const done = await s.mission({});
			const supersededPreview = await s.mission({});
			const none = await s.mission({});
			await s.export(previewed, "previewed", at(1));
			await s.export(prOpen, "pr-open", at(1));
			await s.export(done, "done", at(1));
			await s.export(supersededPreview, "previewed", at(1));
			await s.export(supersededPreview, "done", at(2));

			const list = await listOf(call, "origin=internal");
			const byId = Object.fromEntries(list.data.map((m) => [m.id, m]));
			expect(byId[previewed]?.needsYou).toEqual({ reason: "export_previewed" });
			expect(byId[prOpen]?.needsYou).toEqual({ reason: "pr_open" });
			expect(byId[done]?.needsYou).toBeNull();
			expect(byId[supersededPreview]?.needsYou).toBeNull();
			expect(byId[supersededPreview]?.lastExport).toMatchObject({
				status: "done",
				createdAt: at(2).toISOString(),
			});
			expect(byId[none]).toMatchObject({ needsYou: null, lastExport: null });
			expect(list.meta.counts.needsYou).toBe(2);
		});
	});

	it("filters to missions that need the operator with needsYou=true, keeping counts and paging intact", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const previewed = await s.mission({ status: "active" });
			const prOpen = await s.mission({ status: "halted" });
			const prOpen2 = await s.mission({ status: "active" });
			const quiet = await s.mission({ status: "active" });
			await s.export(previewed, "previewed", at(1));
			await s.export(prOpen, "pr-open", at(1));
			await s.export(prOpen2, "pr-open", at(1));
			await s.export(quiet, "done", at(1));

			const all = await listOf(call, "origin=internal");
			const only = await listOf(call, "origin=internal&needsYou=true");
			expect(only.data.map((m) => m.id).sort()).toEqual(
				[previewed, prOpen, prOpen2].sort(),
			);
			expect(only.data.every((m) => m.needsYou !== null)).toBe(true);
			expect(only.meta.counts).toEqual(all.meta.counts);

			const combined = await listOf(
				call,
				"origin=internal&needsYou=true&status=active",
			);
			expect(combined.data.map((m) => m.id).sort()).toEqual(
				[previewed, prOpen2].sort(),
			);

			expect(await walk(call, "origin=internal&needsYou=true", 1)).toEqual(
				only.data.map((m) => m.id),
			);
			const off = await listOf(call, "origin=internal&needsYou=false");
			expect(off.data).toHaveLength(4);
			expect(
				(await call("/api/missions?origin=internal&needsYou=yes")).status,
			).toBe(400);
		});
	});

	it("carries the last export's statusChangedAt on list and get, distinct from createdAt", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const m = await s.mission({});
			await s.export(m, "done", at(1));
			await s.export(m, "verifying", at(2), at(65));

			const list = await listOf(call, "origin=internal");
			expect(list.data[0]?.lastExport).toMatchObject({
				status: "verifying",
				createdAt: at(2).toISOString(),
				statusChangedAt: at(65).toISOString(),
			});
			const { data } = successEnvelope(missionDetail).parse(
				await (await call(`/api/missions/${m}`)).json(),
			);
			expect(data.lastExport).toMatchObject({
				createdAt: at(2).toISOString(),
				statusChangedAt: at(65).toISOString(),
				gates: null,
			});
		});
	});

	it("takes lastActivityAt from ActivityLog, never from updatedAt", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const edited = await s.mission({ updatedAt: at(60) });
			const neverActive = await s.mission({ updatedAt: at(90) });
			await s.activity(edited, at(5));
			const list = await listOf(call, "origin=internal");
			const byId = Object.fromEntries(list.data.map((m) => [m.id, m]));
			expect(byId[edited]?.lastActivityAt).toBe(at(5).toISOString());
			expect(byId[neverActive]?.lastActivityAt).toBeNull();
			expect(byId[neverActive]?.updatedAt).toBe(at(90).toISOString());
		});
	});

	it("excludes soft-deleted missions, and client missions whose engagement or client is deleted", async () => {
		await withMissions(async ({ tx, ids, call }) => {
			const s = seeder(tx, ids);
			const liveEngagement = await s.engagement(await s.client("Live"), "E");
			const deadEngagement = await s.engagement(
				await s.client("Has dead E"),
				"E",
				remove(clock),
			);
			const deadClient = await s.engagement(
				await s.client("Dead", remove(clock)),
				"E",
			);
			const kept = await s.mission({ engagementId: liveEngagement });
			const deleted = await s.mission({
				engagementId: liveEngagement,
				...remove(clock),
			});
			const orphanedByEngagement = await s.mission({
				engagementId: deadEngagement,
			});
			const orphanedByClient = await s.mission({ engagementId: deadClient });

			const list = await listOf(call, "origin=client&includeArchived=true");
			expect(list.data.map((m) => m.id)).toEqual([kept]);
			expect(list.meta.counts.byStatus.active).toBe(1);
			for (const id of [deleted, orphanedByEngagement, orphanedByClient]) {
				expect((await call(`/api/missions/${id}`)).status, id).toBe(404);
			}
			expect((await call(`/api/missions/${kept}`)).status).toBe(200);
		});
	});

	it("refuses list and get without a session with 401", async () => {
		await withMissions(async ({ anonymous }) => {
			expect((await anonymous("/api/missions?origin=client")).status).toBe(401);
			expect(
				(await anonymous("/api/missions/00000000-0000-4000-8000-000000000999"))
					.status,
			).toBe(401);
		});
	});

	describe("get", () => {
		it("adds brief, spend, rationale, repo, live roster counts, the live playbook, null gates and recent activity", async () => {
			await withMissions(async ({ tx, ids, call, operatorId }) => {
				const s = seeder(tx, ids);
				const e = await s.engagement(await s.client("Meridian"), "App");
				const m = await s.mission({
					engagementId: e,
					type: "full-build",
					brief: { goal: "ship" },
					spendCeilingUsd: "1250.50",
					cutSource: "overridden",
					cutRationale: "Monorepo with a layered backend",
				});
				await s.export(m, "pr-open", at(1));

				const preset = ids.next();
				await tx.insert(rosterPreset).values({
					id: preset,
					name: "Full build",
					cut: "vertical",
					agents: [],
					version: 1,
					...stamp(clock),
				});
				await tx.insert(playbook).values({
					id: ids.next(),
					missionType: "full-build",
					name: "Full build v1",
					wavesApplicable: ["A"],
					gates: [],
					deliverable: "pr",
					requiredFields: [],
					defaultPresetId: preset,
					version: 1,
					...stamp(clock),
				});
				const template = ids.next();
				await tx.insert(agentTemplate).values({
					id: template,
					slug: "backend",
					name: "Backend",
					kind: "feature",
					roles: ["domain"],
					waveDefaults: ["A"],
					identityMd: "#",
					depthMd: "#",
					writablePaths: ["src/**"],
					version: 1,
					...stamp(clock),
				});
				const entry = (active: boolean, extra = {}) => ({
					id: ids.next(),
					missionId: m,
					agentTemplateId: template,
					active,
					waves: ["A" as const],
					grain: "default" as const,
					absorbedBoundaries: [],
					...stamp(clock),
					...extra,
				});
				await tx
					.insert(rosterEntry)
					.values([
						entry(true),
						entry(true),
						entry(false),
						entry(true, remove(clock)),
					]);
				for (let i = 0; i < 12; i++) {
					await s.activity(m, at(i), i === 11 ? operatorId : undefined);
				}

				const res = await call(`/api/missions/${m}`);
				expect(res.status).toBe(200);
				const { data } = successEnvelope(missionDetail).parse(await res.json());
				expect(data).toMatchObject({
					brief: { goal: "ship" },
					spendCeilingUsd: 1250.5,
					cutSource: "overridden",
					cutRationale: "Monorepo with a layered backend",
					repoUrl: "https://github.com/meridian-co/app",
					roster: { agents: 3, active: 2 },
					playbook: { missionType: "full-build", name: "Full build v1" },
					lastExport: { status: "pr-open", gates: null },
					needsYou: { reason: "pr_open" },
					lastActivityAt: at(11).toISOString(),
					client: { name: "Meridian" },
				});
				expect(data.recentActivity).toHaveLength(10);
				expect(data.recentActivity[0]).toMatchObject({
					at: at(11).toISOString(),
					actor: { kind: "operator", userId: operatorId, display: "operator" },
				});
				expect(data.recentActivity[9]?.at).toBe(at(2).toISOString());
				expect(data.recentActivity[1]?.actor).toEqual({
					kind: "system",
					userId: null,
					display: null,
				});
			});
		});

		it("returns null playbook, zero roster and no activity for a bare mission", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const m = await seeder(tx, ids).mission({ type: "unknown-type" });
				const { data } = successEnvelope(missionDetail).parse(
					await (await call(`/api/missions/${m}`)).json(),
				);
				expect(data).toMatchObject({
					playbook: null,
					roster: { agents: 0, active: 0 },
					recentActivity: [],
					lastExport: null,
					spendCeilingUsd: null,
				});
			});
		});
	});

	describe("strip filters: quietBefore, lastExportStatus, direction, total", () => {
		it("quietBefore keeps missions quiet before the instant, no-activity included; direction=asc puts the quietest first", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const old = await s.mission({});
				const older = await s.mission({});
				const recent = await s.mission({});
				const silent1 = await s.mission({});
				const silent2 = await s.mission({});
				await s.activity(old, at(10));
				await s.activity(older, at(5));
				await s.activity(recent, at(60));
				const cutoff = encodeURIComponent(at(30).toISOString());
				const query = `origin=internal&quietBefore=${cutoff}&sort=lastActivity&direction=asc`;

				const quiet = await listOf(call, query);
				// Nulls first (by id, ascending), then oldest activity first.
				expect(quiet.data.map((m) => m.id)).toEqual([
					silent1,
					silent2,
					older,
					old,
				]);
				expect(quiet.meta.total).toBe(4);
				expect(await walk(call, query, 1)).toEqual([
					silent1,
					silent2,
					older,
					old,
				]);

				// The default direction is unchanged: newest first, nulls last.
				const desc = await listOf(
					call,
					`origin=internal&quietBefore=${cutoff}`,
				);
				expect(desc.data.map((m) => m.id)).toEqual([
					old,
					older,
					silent2,
					silent1,
				]);

				// Counts ignore the strip filters, as they ignore status.
				expect(quiet.meta.counts.byStatus.active).toBe(5);
				expect(
					(await call("/api/missions?origin=internal&quietBefore=yesterday"))
						.status,
				).toBe(400);
			});
		});

		it("direction applies to every sort, and a cursor is bound to its direction", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const a = await s.mission({ sprintN: 3 });
				const b = await s.mission({ sprintN: 1 });
				const c = await s.mission({ sprintN: 2 });
				expect(
					await walk(call, "origin=internal&sort=sprint&direction=asc", 1),
				).toEqual([b, c, a]);
				expect(
					await walk(call, "origin=internal&sort=sprint&direction=desc", 1),
				).toEqual([a, c, b]);

				const page = await listOf(
					call,
					"origin=internal&sort=sprint&direction=asc&limit=1",
				);
				const crossed = await call(
					`/api/missions?origin=internal&sort=sprint&cursor=${page.meta.nextCursor}`,
				);
				expect(crossed.status).toBe(400);
				expect(
					(await call("/api/missions?origin=internal&direction=up")).status,
				).toBe(400);
			});
		});

		it("lastExportStatus keeps missions whose newest export is in the set, in either array form", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const verifying = await s.mission({});
				const delivering = await s.mission({});
				const done = await s.mission({});
				const wasVerifying = await s.mission({});
				await s.mission({});
				await s.export(verifying, "verifying", at(1));
				await s.export(delivering, "delivering", at(1));
				await s.export(done, "done", at(1));
				await s.export(wasVerifying, "verifying", at(1));
				await s.export(wasVerifying, "failed", at(2));

				const repeated = await listOf(
					call,
					"origin=internal&lastExportStatus=verifying&lastExportStatus=delivering",
				);
				expect(repeated.data.map((m) => m.id).sort()).toEqual(
					[verifying, delivering].sort(),
				);
				expect(repeated.meta.total).toBe(2);
				const indexed = await listOf(
					call,
					"origin=internal&lastExportStatus%5B0%5D=verifying&lastExportStatus%5B1%5D=delivering",
				);
				expect(indexed.data.map((m) => m.id).sort()).toEqual(
					[verifying, delivering].sort(),
				);
				expect(
					(await call("/api/missions?origin=internal&lastExportStatus=shipped"))
						.status,
				).toBe(400);
			});
		});

		it("meta.total counts every list filter, the same on every page", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				for (const status of [
					"active",
					"active",
					"active",
					"halted",
					"draft",
				] as const) {
					const m = await s.mission({ status });
					await s.export(m, "verifying", at(1));
				}
				await s.mission({ status: "active" });

				expect((await listOf(call, "origin=internal")).meta.total).toBe(6);
				const query =
					"origin=internal&status=active&lastExportStatus=verifying&limit=2";
				const first = await listOf(call, query);
				expect(first.meta.total).toBe(3);
				const second = await listOf(
					call,
					`${query}&cursor=${first.meta.nextCursor}`,
				);
				expect(second.meta.total).toBe(3);
				expect(first.data.length + second.data.length).toBe(3);
				expect(first.meta.counts.byStatus).toMatchObject({
					active: 4,
					halted: 1,
					draft: 1,
				});
			});
		});
	});

	describe("query count", () => {
		it("list sends exactly two mission queries, whatever the page holds", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				for (let i = 0; i < 12; i++) {
					const m = await s.mission({ sprintN: i });
					await s.export(m, "done", at(i));
					await s.activity(m, at(i));
				}
				for (const sort of ["lastActivity", "sprint", "client"]) {
					const from = statements.length;
					const page = await listOf(
						call,
						`origin=internal&limit=10&sort=${sort}&direction=asc&quietBefore=${encodeURIComponent(at(100).toISOString())}&lastExportStatus=done`,
					);
					expect(page.data).toHaveLength(10);
					expect(missionStatements(from), sort).toHaveLength(2);
				}
			});
		});

		it("get sends exactly two mission queries", async () => {
			await withMissions(async ({ tx, ids, call }) => {
				const s = seeder(tx, ids);
				const m = await s.mission({});
				for (let i = 0; i < 12; i++) await s.activity(m, at(i));
				const from = statements.length;
				expect((await call(`/api/missions/${m}`)).status).toBe(200);
				expect(missionStatements(from)).toHaveLength(2);
			});
		});
	});
});
