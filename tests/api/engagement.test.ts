import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	clientSchema,
	engagementSchema,
	engagementStatus,
	errorEnvelope,
	pageEnvelope,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	activityLog,
	connection,
	engagement,
	engagementStatus as engagementStatusEnum,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import { type ApiHarness, clock, idsFailingAt, withApi } from "./support";

const one = successEnvelope(engagementSchema);
const list = pageEnvelope(engagementSchema);

async function newClient(call: ApiHarness["call"], name = "Meridian") {
	const res = await call("/api/clients", { method: "POST", body: { name } });
	return successEnvelope(clientSchema).parse(await res.json()).data.id;
}

async function newEngagement(
	call: ApiHarness["call"],
	clientId: string,
	name = "Sprint",
) {
	const res = await call("/api/engagements", {
		method: "POST",
		body: { clientId, name },
	});
	expect(res.status).toBe(201);
	return one.parse(await res.json()).data;
}

let seq = 0;
async function addConnection(
	tx: Tx,
	engagementId: string | null,
	overrides: Partial<typeof connection.$inferInsert> = {},
) {
	seq += 1;
	const id = `cccccccc-0000-4000-8000-${String(seq).padStart(12, "0")}`;
	await tx.insert(connection).values({
		id,
		service: "github",
		label: `conn ${seq}`,
		scopeType: "repo",
		scopeValue: "meridian/app",
		credentialRef: "env:GITHUB_TOKEN",
		status: "active",
		engagementId,
		...stamp(clock),
		...overrides,
	});
	return id;
}

describe("engagement contract vocabulary", () => {
	it("matches the engagement_status pgEnum exactly", () => {
		expect(engagementStatus.options).toEqual(engagementStatusEnum.enumValues);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/engagements", () => {
	afterAll(closeDb);

	it("creates an active engagement under a client, starting now, and logs engagement.created", async () => {
		await withApi(async ({ signIn, call, logRows }) => {
			await signIn();
			const clientId = await newClient(call);
			const created = await newEngagement(call, clientId);
			expect(created).toMatchObject({
				clientId,
				status: "active",
				startedAt: clock.now().toISOString(),
				closedAt: null,
				scopeMd: null,
			});
			const logs = await logRows(created.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				action: "engagement.created",
				engagementId: created.id,
			});
		});
	});

	it("refuses an engagement under a missing or closed client with 422, writing nothing", async () => {
		await withApi(async ({ signIn, call, tx }) => {
			await signIn();
			const missing = await call("/api/engagements", {
				method: "POST",
				body: { clientId: "00000000-0000-4000-8000-000000000999", name: "X" },
			});
			expect(missing.status).toBe(422);
			const body = errorEnvelope.parse(await missing.json());
			expect(body.error.code).toBe("PRECONDITION_FAILED");
			expect(body.error.details).toMatchObject({ reason: "client_not_found" });

			const clientId = await newClient(call);
			await call(`/api/clients/${clientId}`, {
				method: "PATCH",
				body: { status: "closed" },
			});
			const closed = await call("/api/engagements", {
				method: "POST",
				body: { clientId, name: "X" },
			});
			expect(closed.status).toBe(422);
			expect(
				errorEnvelope.parse(await closed.json()).error.details,
			).toMatchObject({ reason: "client_closed" });

			expect(await tx.select().from(engagement)).toHaveLength(0);
			expect(
				await tx
					.select()
					.from(activityLog)
					.where(eq(activityLog.action, "engagement.created")),
			).toHaveLength(0);
		});
	});

	it("gets, updates (logging engagement.updated), and lists filtered by client", async () => {
		await withApi(async ({ signIn, call, logRows }) => {
			await signIn();
			const a = await newClient(call, "A");
			const b = await newClient(call, "B");
			const e1 = await newEngagement(call, a, "A1");
			await newEngagement(call, b, "B1");
			const e3 = await newEngagement(call, a, "A2");

			expect(
				one.parse(await (await call(`/api/engagements/${e1.id}`)).json()).data
					.name,
			).toBe("A1");

			const res = await call(`/api/engagements/${e1.id}`, {
				method: "PATCH",
				body: { scopeMd: "# Scope" },
			});
			expect(one.parse(await res.json()).data.scopeMd).toBe("# Scope");
			expect((await logRows(e1.id)).map((r) => r.action)).toEqual([
				"engagement.created",
				"engagement.updated",
			]);

			const forA = list.parse(
				await (await call(`/api/engagements?clientId=${a}`)).json(),
			);
			expect(forA.data.map((e) => e.id)).toEqual([e3.id, e1.id]);
		});
	});

	it("refuses to change status or client through update: 400", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			const e = await newEngagement(call, await newClient(call));
			expect(
				(
					await call(`/api/engagements/${e.id}`, {
						method: "PATCH",
						body: { status: "closed" },
					})
				).status,
			).toBe(400);
			expect(
				(
					await call(`/api/engagements/${e.id}`, {
						method: "PATCH",
						body: { clientId: e.clientId },
					})
				).status,
			).toBe(400);
		});
	});

	it("answers 404 for a soft-deleted engagement on get, update, close and list", async () => {
		await withApi(async ({ signIn, call, tx }) => {
			await signIn();
			const e = await newEngagement(call, await newClient(call));
			await tx
				.update(engagement)
				.set(remove(clock))
				.where(eq(engagement.id, e.id));
			expect((await call(`/api/engagements/${e.id}`)).status).toBe(404);
			expect(
				(
					await call(`/api/engagements/${e.id}`, {
						method: "PATCH",
						body: { name: "Y" },
					})
				).status,
			).toBe(404);
			expect(
				(await call(`/api/engagements/${e.id}/close`, { method: "POST" }))
					.status,
			).toBe(404);
			expect(
				list.parse(await (await call("/api/engagements")).json()).data,
			).toHaveLength(0);
		});
	});

	it("refuses every engagement route without a session with 401", async () => {
		await withApi(async ({ app }) => {
			const id = "00000000-0000-4000-8000-000000000999";
			for (const [method, path] of [
				["GET", "/api/engagements"],
				["GET", `/api/engagements/${id}`],
				["POST", "/api/engagements"],
				["PATCH", `/api/engagements/${id}`],
				["POST", `/api/engagements/${id}/close`],
			] as const) {
				expect(
					(await app.request(path, { method })).status,
					`${method} ${path}`,
				).toBe(401);
			}
		});
	});

	describe("close", () => {
		it("sets status closed and closedAt from the clock, logs engagement.closed, and refuses a second close with 409", async () => {
			await withApi(async ({ signIn, call, logRows }) => {
				await signIn();
				const e = await newEngagement(call, await newClient(call));
				const res = await call(`/api/engagements/${e.id}/close`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				expect(one.parse(await res.json()).data).toMatchObject({
					status: "closed",
					closedAt: clock.now().toISOString(),
				});
				expect((await logRows(e.id)).map((r) => r.action)).toContain(
					"engagement.closed",
				);

				const again = await call(`/api/engagements/${e.id}/close`, {
					method: "POST",
				});
				expect(again.status).toBe(409);
				expect(errorEnvelope.parse(await again.json()).error.code).toBe(
					"CONFLICT",
				);
			});
		});

		it("revokes only this engagement's live connections, each with a connection.revoked row", async () => {
			await withApi(async ({ signIn, call, tx, logRows }) => {
				await signIn();
				const clientId = await newClient(call);
				const target = await newEngagement(call, clientId, "Target");
				const other = await newEngagement(call, clientId, "Other");

				const active = await addConnection(tx, target.id);
				const expired = await addConnection(tx, target.id, {
					status: "expired",
				});
				const revokedEarlier = await addConnection(tx, target.id, {
					status: "revoked",
					revokedAt: new Date("2026-01-01T00:00:00.000Z"),
				});
				const deleted = await addConnection(tx, target.id, remove(clock));
				const otherEngagement = await addConnection(tx, other.id);
				const internal = await addConnection(tx, null);

				const res = await call(`/api/engagements/${target.id}/close`, {
					method: "POST",
				});
				expect(res.status).toBe(200);

				const rows = await tx
					.select()
					.from(connection)
					.where(
						inArray(connection.id, [
							active,
							expired,
							revokedEarlier,
							deleted,
							otherEngagement,
							internal,
						]),
					);
				const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

				for (const id of [active, expired]) {
					expect(byId[id]).toMatchObject({
						status: "revoked",
						revokedAt: clock.now(),
					});
					const logs = await logRows(id);
					expect(logs).toHaveLength(1);
					expect(logs[0]).toMatchObject({
						action: "connection.revoked",
						entityType: "connection",
						engagementId: target.id,
						actorKind: "operator",
					});
				}
				// Already revoked: untouched, keeps its original revoked_at, no new row.
				expect(byId[revokedEarlier]?.revokedAt).toEqual(
					new Date("2026-01-01T00:00:00.000Z"),
				);
				expect(await logRows(revokedEarlier)).toHaveLength(0);
				// Soft-deleted, another engagement's, and internal: untouched.
				for (const id of [deleted, otherEngagement, internal]) {
					expect(byId[id]?.revokedAt ?? null, id).toBeNull();
					expect(await logRows(id)).toHaveLength(0);
				}
				expect(byId[otherEngagement]?.status).toBe("active");
				expect(byId[internal]?.status).toBe("active");
			});
		});

		it("commits nothing when a revocation fails: no closed engagement, no revoked connection, no log rows", async () => {
			await withApi(
				async ({ signIn, call, tx, logRows }) => {
					await signIn();
					const e = await newEngagement(call, await newClient(call));
					const conn = await addConnection(tx, e.id);
					// The app's generator fails on its 10th call, the id of the
					// connection.revoked row: sign-in (1, 2), client create (3-5),
					// engagement create (6-8), the close's request id (9). The close
					// transaction then fails inside the revocation step.
					const res = await call(`/api/engagements/${e.id}/close`, {
						method: "POST",
					});
					expect(res.status).toBe(500);

					const [after] = await tx
						.select()
						.from(engagement)
						.where(eq(engagement.id, e.id));
					expect(after).toMatchObject({ status: "active", closedAt: null });
					const [c] = await tx
						.select()
						.from(connection)
						.where(eq(connection.id, conn));
					expect(c).toMatchObject({ status: "active", revokedAt: null });
					expect(await logRows(conn)).toHaveLength(0);
					expect(
						await tx
							.select()
							.from(activityLog)
							.where(
								and(
									eq(activityLog.entityId, e.id),
									eq(activityLog.action, "engagement.closed"),
								),
							),
					).toHaveLength(0);
				},
				{ ids: idsFailingAt(10) },
			);
		});
	});
});
