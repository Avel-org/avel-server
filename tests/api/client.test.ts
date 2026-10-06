import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	clientSchema,
	clientStatus,
	engagementSchema,
	errorEnvelope,
	pageEnvelope,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import {
	client,
	clientStatus as clientStatusEnum,
	engagement,
} from "../../src/db/schema";
import { remove, stamp } from "../../src/db/schema/columns";
import { clock, idsFailingAt, withApi } from "./support";

const one = successEnvelope(clientSchema);
const list = pageEnvelope(clientSchema);

describe("client contract vocabulary", () => {
	it("matches the client_status pgEnum exactly", () => {
		expect(clientStatus.options).toEqual(clientStatusEnum.enumValues);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("/api/clients", () => {
	afterAll(closeDb);

	it("creates an active client, 201, and logs client.created in the same transaction", async () => {
		await withApi(async ({ signIn, call, logRows, tx }) => {
			await signIn();
			const res = await call("/api/clients", {
				method: "POST",
				body: { name: "  Meridian  ", primaryContact: "Ana" },
			});
			expect(res.status).toBe(201);
			const { data } = one.parse(await res.json());
			expect(data).toMatchObject({
				name: "Meridian",
				status: "active",
				primaryContact: "Ana",
				notesMd: null,
				engagementCount: 0,
				activeEngagementCount: 0,
				createdAt: clock.now().toISOString(),
			});
			const logs = await logRows(data.id);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				action: "client.created",
				entityType: "client",
				actorKind: "operator",
			});
			const [row] = await tx
				.select()
				.from(client)
				.where(eq(client.id, data.id));
			expect(row?.primaryContact).toBe("Ana");
		});
	});

	it("gets one client and updates it, logging client.updated with the changes", async () => {
		await withApi(async ({ signIn, call, logRows }) => {
			await signIn();
			const created = one.parse(
				await (
					await call("/api/clients", {
						method: "POST",
						body: { name: "Meridian" },
					})
				).json(),
			);
			const id = created.data.id;

			const got = await call(`/api/clients/${id}`);
			expect(got.status).toBe(200);
			expect(one.parse(await got.json()).data.name).toBe("Meridian");

			const res = await call(`/api/clients/${id}`, {
				method: "PATCH",
				body: { status: "closed", notesMd: "# Done" },
			});
			expect(res.status).toBe(200);
			expect(one.parse(await res.json()).data).toMatchObject({
				status: "closed",
				notesMd: "# Done",
			});
			const updates = (await logRows(id)).filter(
				(r) => r.action === "client.updated",
			);
			expect(updates).toHaveLength(1);
			expect(updates[0]?.payload).toEqual({
				changes: { status: "closed", notesMd: "# Done" },
			});
		});
	});

	it("lists newest first in pages, with a cursor that reaches every client once", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			const ids: string[] = [];
			for (const name of ["A", "B", "C"]) {
				const res = await call("/api/clients", {
					method: "POST",
					body: { name },
				});
				ids.push(one.parse(await res.json()).data.id);
			}
			const first = list.parse(
				await (await call("/api/clients?limit=2")).json(),
			);
			expect(first.data.map((c) => c.name)).toEqual(["C", "B"]);
			expect(first.meta.nextCursor).not.toBeNull();
			const second = list.parse(
				await (
					await call(`/api/clients?limit=2&cursor=${first.meta.nextCursor}`)
				).json(),
			);
			expect(second.data.map((c) => c.name)).toEqual(["A"]);
			expect(second.meta.nextCursor).toBeNull();
		});
	});

	it("counts only live engagements, and active ones separately", async () => {
		await withApi(async ({ signIn, call, tx }) => {
			await signIn();
			const { data } = one.parse(
				await (
					await call("/api/clients", {
						method: "POST",
						body: { name: "Meridian" },
					})
				).json(),
			);
			const base = {
				clientId: data.id,
				startedAt: clock.now(),
				...stamp(clock),
			};
			await tx.insert(engagement).values([
				{
					...base,
					id: "bbbbbbbb-0000-4000-8000-000000000001",
					name: "Live active",
					status: "active",
				},
				{
					...base,
					id: "bbbbbbbb-0000-4000-8000-000000000002",
					name: "Live closed",
					status: "closed",
				},
				{
					...base,
					id: "bbbbbbbb-0000-4000-8000-000000000003",
					name: "Deleted",
					status: "active",
					...remove(clock),
				},
			]);
			const got = one.parse(
				await (await call(`/api/clients/${data.id}`)).json(),
			);
			expect(got.data).toMatchObject({
				engagementCount: 2,
				activeEngagementCount: 1,
			});
		});
	});

	it("answers 404 for a soft-deleted client, on get, update and in the list", async () => {
		await withApi(async ({ signIn, call, tx }) => {
			await signIn();
			const { data } = one.parse(
				await (
					await call("/api/clients", { method: "POST", body: { name: "Gone" } })
				).json(),
			);
			await tx.update(client).set(remove(clock)).where(eq(client.id, data.id));

			const got = await call(`/api/clients/${data.id}`);
			expect(got.status).toBe(404);
			expect(errorEnvelope.parse(await got.json()).error.code).toBe(
				"NOT_FOUND",
			);
			expect(
				(
					await call(`/api/clients/${data.id}`, {
						method: "PATCH",
						body: { name: "Back" },
					})
				).status,
			).toBe(404);
			const listed = list.parse(await (await call("/api/clients")).json());
			expect(listed.data.map((c) => c.id)).not.toContain(data.id);
		});
	});

	it.each([
		["an empty name", { name: "   " }],
		["an unknown field", { name: "Meridian", status: "closed" }],
		["no name", { notesMd: "x" }],
	])("refuses a create with %s: 400 VALIDATION_FAILED, no row, no log", async (_label, body) => {
		await withApi(async ({ signIn, call, tx }) => {
			await signIn();
			const res = await call("/api/clients", { method: "POST", body });
			expect(res.status).toBe(400);
			expect(errorEnvelope.parse(await res.json()).error.code).toBe(
				"VALIDATION_FAILED",
			);
			expect(await tx.select().from(client)).toHaveLength(0);
		});
	});

	it("refuses an empty update and a malformed id with 400", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			const { data } = one.parse(
				await (
					await call("/api/clients", { method: "POST", body: { name: "M" } })
				).json(),
			);
			expect(
				(await call(`/api/clients/${data.id}`, { method: "PATCH", body: {} }))
					.status,
			).toBe(400);
			expect((await call("/api/clients/not-a-uuid")).status).toBe(400);
			expect((await call("/api/clients?cursor=garbage")).status).toBe(400);
		});
	});

	it.each([
		["36 hyphens as the id", ["2026-10-05T12:00:00.000Z", "-".repeat(36)]],
		[
			"a non-ISO timestamp",
			["October 5 2026", "00000000-0000-4000-8000-000000000001"],
		],
		["a number as the timestamp", [0, "00000000-0000-4000-8000-000000000001"]],
	])("refuses a forged cursor with %s: 400, never a database error", async (_label, position) => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			const cursor = Buffer.from(JSON.stringify(position)).toString(
				"base64url",
			);
			const res = await call(`/api/clients?cursor=${cursor}`);
			expect(res.status).toBe(400);
			expect(errorEnvelope.parse(await res.json()).error.code).toBe(
				"VALIDATION_FAILED",
			);
		});
	});

	it("refuses every client route without a session with 401", async () => {
		await withApi(async ({ app }) => {
			const id = "00000000-0000-4000-8000-000000000999";
			for (const [method, path] of [
				["GET", "/api/clients"],
				["GET", `/api/clients/${id}`],
				["POST", "/api/clients"],
				["PATCH", `/api/clients/${id}`],
			] as const) {
				const res = await app.request(path, { method });
				expect(res.status, `${method} ${path}`).toBe(401);
			}
		});
	});

	describe("closing a client", () => {
		async function clientWithEngagement(
			call: (
				path: string,
				init?: { method?: string; body?: unknown },
			) => Promise<Response>,
		) {
			const { data } = one.parse(
				await (
					await call("/api/clients", {
						method: "POST",
						body: { name: "Meridian" },
					})
				).json(),
			);
			const res = await call("/api/engagements", {
				method: "POST",
				body: { clientId: data.id, name: "Sprint" },
			});
			const engagementId = successEnvelope(engagementSchema).parse(
				await res.json(),
			).data.id;
			return { clientId: data.id, engagementId };
		}

		it("is refused with 422 while a live engagement is active, changing nothing and logging nothing", async () => {
			await withApi(async ({ signIn, call, tx, logRows }) => {
				await signIn();
				const { clientId } = await clientWithEngagement(call);
				const res = await call(`/api/clients/${clientId}`, {
					method: "PATCH",
					body: { status: "closed", notesMd: "wrapping up" },
				});
				expect(res.status).toBe(422);
				const body = errorEnvelope.parse(await res.json());
				expect(body.error.code).toBe("PRECONDITION_FAILED");
				expect(body.error.details).toMatchObject({
					reason: "client_has_active_engagements",
				});
				const [row] = await tx
					.select()
					.from(client)
					.where(eq(client.id, clientId));
				expect(row).toMatchObject({ status: "active", notesMd: null });
				expect((await logRows(clientId)).map((r) => r.action)).toEqual([
					"client.created",
				]);
			});
		});

		it("is allowed once every engagement is closed", async () => {
			await withApi(async ({ signIn, call }) => {
				await signIn();
				const { clientId, engagementId } = await clientWithEngagement(call);
				await call(`/api/engagements/${engagementId}/close`, {
					method: "POST",
				});
				const res = await call(`/api/clients/${clientId}`, {
					method: "PATCH",
					body: { status: "closed" },
				});
				expect(res.status).toBe(200);
				expect(one.parse(await res.json()).data.status).toBe("closed");
			});
		});

		it("is not blocked by a soft-deleted active engagement", async () => {
			await withApi(async ({ signIn, call, tx }) => {
				await signIn();
				const { clientId, engagementId } = await clientWithEngagement(call);
				await tx
					.update(engagement)
					.set(remove(clock))
					.where(eq(engagement.id, engagementId));
				const res = await call(`/api/clients/${clientId}`, {
					method: "PATCH",
					body: { status: "closed" },
				});
				expect(res.status).toBe(200);
			});
		});

		it("does not check engagements for an update that leaves status alone", async () => {
			await withApi(async ({ signIn, call }) => {
				await signIn();
				const { clientId } = await clientWithEngagement(call);
				const res = await call(`/api/clients/${clientId}`, {
					method: "PATCH",
					body: { name: "Meridian Health" },
				});
				expect(res.status).toBe(200);
			});
		});
	});

	it("commits nothing when the log row fails: no client and no log row", async () => {
		// Calls to the app's generator: sign-in start (1), callback (2), the
		// create's request id (3), the client id (4), the log row's id (5).
		await withApi(
			async ({ signIn, call, tx }) => {
				await signIn();
				const res = await call("/api/clients", {
					method: "POST",
					body: { name: "Half" },
				});
				expect(res.status).toBe(500);
				expect(await tx.select().from(client)).toHaveLength(0);
				expect(
					await tx.select().from(client).where(eq(client.name, "Half")),
				).toHaveLength(0);
			},
			{ ids: idsFailingAt(5) },
		);
	});
});
