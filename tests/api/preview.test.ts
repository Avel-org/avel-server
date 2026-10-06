import { afterAll, describe, expect, it } from "vitest";
import { clientSchema, errorEnvelope, pageEnvelope } from "../../src/contract";
import { client } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { clock, closeApi, prefixedIds, withApi } from "./support";

const list = pageEnvelope(clientSchema);

describe.skipIf(!process.env.DATABASE_URL)(
	"dev preview against Postgres",
	() => {
		afterAll(closeApi);

		async function seedClient(
			tx: Parameters<Parameters<typeof withApi>[0]>[0]["tx"],
		) {
			const id = prefixedIds("5eed0000").next();
			await tx
				.insert(client)
				.values({ id, name: "Seeded Co", status: "active", ...stamp(clock) });
			return id;
		}

		it("serves seeded data to a sessionless GET, with the preview header", async () => {
			await withApi(
				async ({ tx, app }) => {
					const id = await seedClient(tx);
					const res = await app.request("/api/clients");
					expect(res.status).toBe(200);
					expect(res.headers.get("x-avel-preview")).toBe("1");
					expect(list.parse(await res.json()).data.map((c) => c.id)).toContain(
						id,
					);
				},
				{ preview: true },
			);
		});

		it("still refuses a sessionless POST with 401, writing nothing", async () => {
			await withApi(
				async ({ tx, app }) => {
					const res = await app.request("/api/clients", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: "Sneaky" }),
					});
					expect(res.status).toBe(401);
					expect(errorEnvelope.parse(await res.json()).error.code).toBe(
						"UNAUTHENTICATED",
					);
					expect(await tx.select().from(client)).toHaveLength(0);
				},
				{ preview: true },
			);
		});

		it("is off by default: the same sessionless GET is 401", async () => {
			await withApi(async ({ tx, app }) => {
				await seedClient(tx);
				const res = await app.request("/api/clients");
				expect(res.status).toBe(401);
				expect(res.headers.get("x-avel-preview")).toBeNull();
			});
		});
	},
);
