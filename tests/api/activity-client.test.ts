import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { activityListEnvelope } from "../../src/contract";
import { logActivity } from "../../src/db/activity";
import { activityLog, mission } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { randomIds } from "../../src/lib/ids";
import { seedTenants } from "../db/app-role";
import { seedCanonIdentity } from "../db/canon-fixtures";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

// activity_log.client_id (drizzle/0047): every row on a client carries it,
// so a client's activity and lastActivityAt reach rows with no engagement
// or mission, a client's memory and a Canon session on the client alone.
// Every request runs as avel_app: client_memory and canon_session are under
// row-level security, which the owner bypasses, so a test as the owner
// passed while the server read nothing (2026-10-21).

const asApp = { asApp: true };

async function setUp(h: ApiHarness) {
	await h.signIn();
	const seeded = await seedTenants(h.tx, ["Meridian", "Halcyon"]);
	await seedCanonIdentity(h.tx, "canon");
	const json = async <T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	) => {
		const res = await h.call(path, init);
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return ((await res.json()) as { data: T }).data;
	};
	const activity = async (clientId: string) => {
		const res = await h.call(`/api/activity?clientId=${clientId}&limit=100`);
		expect(res.status).toBe(200);
		const raw = (await res.json()) as { data: Record<string, unknown>[] };
		// Internal only: client_id never reaches the wire.
		for (const row of raw.data)
			expect(Object.keys(row)).not.toContain("clientId");
		return activityListEnvelope.parse(raw).data;
	};
	const lastActivityAt = async (clientId: string) =>
		(await json<{ lastActivityAt: string | null }>(`/api/clients/${clientId}`))
			.lastActivityAt;
	const clientIdsOf = async (entityIds: string[]) =>
		(
			await h.tx
				.select({ id: activityLog.entityId, clientId: activityLog.clientId })
				.from(activityLog)
				.where(inArray(activityLog.entityId, entityIds))
		).map((r) => r.clientId);
	return { ...seeded, json, activity, lastActivityAt, clientIdsOf };
}

describe.skipIf(!process.env.DATABASE_URL)(
	"a client's activity, through activity_log.client_id, as avel_app",
	() => {
		afterAll(closeApi);

		it("takes a Canon session on the client alone, with no engagement, into its activity and lastActivityAt", async () => {
			await withApi(async (h) => {
				const { a, b, json, activity, lastActivityAt, clientIdsOf } =
					await setUp(h);
				expect(await lastActivityAt(a.clientId)).toBeNull();
				const s = await json<{ id: string; engagementId: string | null }>(
					"/api/canon-sessions",
					{ method: "POST", body: { scope: "client", clientId: a.clientId } },
				);
				expect(s.engagementId).toBeNull();
				await json(`/api/canon-sessions/${s.id}/archive`, { method: "POST" });

				const rows = (await activity(a.clientId)).filter(
					(r) => r.entityId === s.id,
				);
				expect(rows.map((r) => [r.action, r.engagementId])).toEqual([
					["canon_session.archived", null],
					["canon_session.closed", null],
					["canon_session.opened", null],
				]);
				expect(await clientIdsOf([s.id])).toEqual([
					a.clientId,
					a.clientId,
					a.clientId,
				]);
				expect(await lastActivityAt(a.clientId)).toBe(
					clock.now().toISOString(),
				);
				expect(
					(await activity(b.clientId)).filter((r) => r.entityId === s.id),
				).toEqual([]);
				expect(await lastActivityAt(b.clientId)).toBeNull();
			}, asApp);
		});

		it("takes a client's memory changes into its activity, and never another client's", async () => {
			await withApi(async (h) => {
				const { a, b, json, activity, lastActivityAt, clientIdsOf } =
					await setUp(h);
				const write = async (clientId: string) =>
					(
						await json<{ id: string }>(`/api/clients/${clientId}/memory`, {
							method: "POST",
							body: { contentMd: "Prefers Tuesday calls" },
						})
					).id;
				const memoryId = await write(a.clientId);
				await json(`/api/client-memory/${memoryId}`, {
					method: "PATCH",
					body: { contentMd: "Prefers Wednesday calls" },
				});
				await json(`/api/client-memory/${memoryId}/remove`, {
					method: "POST",
				});
				const otherId = await write(b.clientId);

				const ofA = (await activity(a.clientId)).filter(
					(r) => r.entityType === "client_memory",
				);
				expect(ofA.map((r) => [r.action, r.entityId])).toEqual([
					["client_memory.removed", memoryId],
					["client_memory.edited", memoryId],
					["client_memory.written", memoryId],
				]);
				const ofB = (await activity(b.clientId)).filter(
					(r) => r.entityType === "client_memory",
				);
				expect(ofB.map((r) => [r.action, r.entityId])).toEqual([
					["client_memory.written", otherId],
				]);
				expect(await clientIdsOf([otherId])).toEqual([b.clientId]);
				expect(await lastActivityAt(a.clientId)).toBe(
					clock.now().toISOString(),
				);
			}, asApp);
		});

		it("leaves an open session's rows on no client, in no client's activity", async () => {
			await withApi(async (h) => {
				const { a, b, json, activity, clientIdsOf } = await setUp(h);
				const s = await json<{ id: string }>("/api/canon-sessions", {
					method: "POST",
					body: { scope: "open" },
				});
				await json(`/api/canon-sessions/${s.id}/archive`, { method: "POST" });
				const ids = await clientIdsOf([s.id]);
				expect(ids.length).toBeGreaterThan(0);
				expect(ids.every((id) => id === null)).toBe(true);
				for (const c of [a, b]) {
					expect(
						(await activity(c.clientId)).filter((r) => r.entityId === s.id),
					).toEqual([]);
				}
			}, asApp);
		});

		it("derives the client from the row's client, engagement or mission, and leaves a row on no client null", async () => {
			await withApi(async (h) => {
				const { json, clientIdsOf } = await setUp(h);
				const c = await json<{ id: string }>("/api/clients", {
					method: "POST",
					body: { name: "Derived" },
				});
				const e = await json<{ id: string }>("/api/engagements", {
					method: "POST",
					body: { clientId: c.id, name: "Portal" },
				});
				expect(await clientIdsOf([c.id, e.id])).toEqual([c.id, c.id]);
				const source = await json<{ id: string }>("/api/skill-sources", {
					method: "POST",
					body: { name: `Source ${h.ns}`, kind: "internal" },
				});
				expect(await clientIdsOf([source.id])).toEqual([null]);

				// A row naming only its mission takes the mission's client.
				const missionId = randomUUID();
				await h.tx.insert(mission).values({
					id: missionId,
					origin: "client",
					engagementId: e.id,
					type: "full-build",
					brief: {},
					sprintN: 1,
					status: "draft",
					cut: "vertical",
					cutSource: "derived",
					repoUrl: "https://github.com/meridian-co/app",
					...stamp(clock),
				});
				const logged = await logActivity(
					h.tx,
					{ clock, ids: randomIds },
					{
						actorKind: "system",
						action: "mission.status_changed",
						entityType: "mission",
						entityId: missionId,
						missionId,
						requestId: "test",
						payload: {},
					},
				);
				expect(logged.clientId).toBe(c.id);
			}, asApp);
		});
	},
);
