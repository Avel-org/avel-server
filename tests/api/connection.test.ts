import { afterAll, describe, expect, it } from "vitest";
import {
	clientSchema,
	connectionListEnvelope,
	connectionSchema,
	connectionScopeType,
	connectionService,
	connectionStatus,
	engagementSchema,
	errorEnvelope,
	preconditionDetails,
	successEnvelope,
} from "../../src/contract";
import {
	connectionScopeType as scopeTypeEnum,
	connectionService as serviceEnum,
	connectionStatus as statusEnum,
} from "../../src/db/schema";
import { type ApiHarness, clock, closeApi, withApi } from "./support";

const url = process.env.DATABASE_URL;
const one = successEnvelope(connectionSchema);
type Call = ApiHarness["call"];

async function newEngagement(call: Call): Promise<string> {
	const c = await call("/api/clients", {
		method: "POST",
		body: { name: "Meridian" },
	});
	const clientId = successEnvelope(clientSchema).parse(await c.json()).data.id;
	const e = await call("/api/engagements", {
		method: "POST",
		body: { clientId, name: "App build" },
	});
	return successEnvelope(engagementSchema).parse(await e.json()).data.id;
}

const body = (
	engagementId: string | null,
	over: Record<string, unknown> = {},
) => ({
	engagementId,
	label: "Meridian engagement",
	scopeType: "owner",
	scopeValue: "meridian-co",
	credentialRef: "MERIDIAN_GITHUB_TOKEN",
	...over,
});

describe("connection contract vocabulary", () => {
	it("matches the pgEnums exactly", () => {
		expect(connectionService.options).toEqual(serviceEnum.enumValues);
		expect(connectionScopeType.options).toEqual(scopeTypeEnum.enumValues);
		expect(connectionStatus.options).toEqual(statusEnum.enumValues);
	});
});

describe.skipIf(!url)("/api/connections", () => {
	afterAll(closeApi);

	it("refuses every route without a session with 401", async () => {
		await withApi(async (api) => {
			for (const [method, path] of [
				["GET", "/api/connections"],
				["GET", "/api/connections/00000000-0000-4000-8000-000000000001"],
				["POST", "/api/connections"],
			] as const) {
				expect((await api.app.request(path, { method })).status).toBe(401);
			}
		});
	});

	it("creates an active GitHub connection, answering and logging the credential's name only", async () => {
		await withApi(async (api) => {
			await api.signIn();
			const engagementId = await newEngagement(api.call);
			const res = await api.call("/api/connections", {
				method: "POST",
				body: body(engagementId),
			});
			expect(res.status, await res.clone().text()).toBe(201);
			const created = one.parse(await res.json()).data;
			expect(created).toEqual({
				id: created.id,
				service: "github",
				engagementId,
				label: "Meridian engagement",
				scopeType: "owner",
				scopeValue: "meridian-co",
				credentialRef: "MERIDIAN_GITHUB_TOKEN",
				status: "active",
				expiresAt: null,
				lastRotatedAt: null,
				revokedAt: null,
				createdAt: clock.now().toISOString(),
				updatedAt: clock.now().toISOString(),
			});
			expect(await api.logRows(created.id)).toMatchObject([
				{
					action: "connection.created",
					entityType: "connection",
					engagementId,
					payload: {
						scopeType: "owner",
						scopeValue: "meridian-co",
						credentialRef: "MERIDIAN_GITHUB_TOKEN",
					},
				},
			]);
			const got = one.parse(
				await (await api.call(`/api/connections/${created.id}`)).json(),
			);
			expect(got.data).toEqual(created);
		});
	});

	it("never checks the credential at create: an unset variable is still a valid name", async () => {
		await withApi(async (api) => {
			await api.signIn();
			const res = await api.call("/api/connections", {
				method: "POST",
				body: body(null, { credentialRef: "NOT_SET_ANYWHERE" }),
			});
			expect(res.status).toBe(201);
			expect(one.parse(await res.json()).data.engagementId).toBeNull();
		});
	});

	it("refuses a token, or anything that is not a variable name, with 400 and stores nothing", async () => {
		await withApi(async (api) => {
			await api.signIn();
			const engagementId = await newEngagement(api.call);
			for (const credentialRef of [
				"ghp_16C7e42F292c6912E7710c838347Ae178B4a",
				"github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
				"meridian_token",
				"1TOKEN",
				"MERIDIAN TOKEN",
				"",
			]) {
				const res = await api.call("/api/connections", {
					method: "POST",
					body: body(engagementId, { credentialRef }),
				});
				expect(res.status, credentialRef).toBe(400);
				if (credentialRef)
					expect(await res.text()).not.toContain(credentialRef);
			}
			const list = connectionListEnvelope.parse(
				await (
					await api.call(`/api/connections?engagementId=${engagementId}`)
				).json(),
			);
			expect(list.data).toEqual([]);
		});
	});

	it("refuses a scope value that does not fit its scope type with 400", async () => {
		await withApi(async (api) => {
			await api.signIn();
			for (const over of [
				{ scopeType: "owner", scopeValue: "meridian-co/app" },
				{ scopeType: "repo", scopeValue: "meridian-co" },
				{ scopeType: "repo", scopeValue: "meridian-co/app/extra" },
				{ scopeType: "owner", scopeValue: "-bad" },
			]) {
				const res = await api.call("/api/connections", {
					method: "POST",
					body: body(null, over),
				});
				expect(res.status, JSON.stringify(over)).toBe(400);
			}
		});
	});

	it("refuses a missing or closed engagement with 422", async () => {
		await withApi(async (api) => {
			await api.signIn();
			const missing = "00000000-0000-4000-8000-00000000ffff";
			const a = await api.call("/api/connections", {
				method: "POST",
				body: body(missing),
			});
			expect(a.status).toBe(422);
			expect(
				preconditionDetails.parse(
					errorEnvelope.parse(await a.json()).error.details,
				),
			).toEqual({ reason: "engagement_not_found", engagementId: missing });

			const engagementId = await newEngagement(api.call);
			await api.call(`/api/engagements/${engagementId}/close`, {
				method: "POST",
			});
			const b = await api.call("/api/connections", {
				method: "POST",
				body: body(engagementId),
			});
			expect(b.status).toBe(422);
			expect(
				preconditionDetails.parse(
					errorEnvelope.parse(await b.json()).error.details,
				).reason,
			).toBe("engagement_closed");
		});
	});

	it("lists newest first, filters by engagement and status, and pages with a steady total", async () => {
		await withApi(async (api) => {
			await api.signIn();
			const engagementId = await newEngagement(api.call);
			const other = await newEngagement(api.call);
			const ids: string[] = [];
			for (const label of ["a", "b", "c"]) {
				const res = await api.call("/api/connections", {
					method: "POST",
					body: body(engagementId, { label }),
				});
				ids.push(one.parse(await res.json()).data.id);
			}
			await api.call("/api/connections", {
				method: "POST",
				body: body(other),
			});
			const list = connectionListEnvelope.parse(
				await (
					await api.call(`/api/connections?engagementId=${engagementId}`)
				).json(),
			);
			expect(list.data.map((c) => c.id)).toEqual([...ids].reverse());
			expect(list.meta.total).toBe(3);

			const revoked = connectionListEnvelope.parse(
				await (
					await api.call(
						`/api/connections?engagementId=${engagementId}&status=revoked`,
					)
				).json(),
			);
			expect(revoked.meta.total).toBe(0);

			const seen: string[] = [];
			let cursor: string | null = null;
			do {
				const page = connectionListEnvelope.parse(
					await (
						await api.call(
							`/api/connections?engagementId=${engagementId}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
						)
					).json(),
				);
				expect(page.meta.total).toBe(3);
				seen.push(...page.data.map((c) => c.id));
				cursor = page.meta.nextCursor;
			} while (cursor && seen.length < 10);
			expect(seen).toEqual([...ids].reverse());
		});
	});

	it("answers 404 for an unknown connection", async () => {
		await withApi(async (api) => {
			await api.signIn();
			const res = await api.call(
				"/api/connections/00000000-0000-4000-8000-00000000ffff",
			);
			expect(res.status).toBe(404);
		});
	});
});
