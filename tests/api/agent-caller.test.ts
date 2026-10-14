import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { dispatch, errorEnvelope, successEnvelope } from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { dispatchWire } from "../../src/db/dispatch";
import { client, finding, rosterEntry } from "../../src/db/schema";
import { remove } from "../../src/db/schema/columns";
import {
	bearer,
	dispatchWithToken,
	seedIds,
	seedRosteredAgent,
} from "./agent-fixtures";
import { clock, withApi } from "./support";

const RUNNER = `avl_run_${"r".repeat(32)}`;
const read = successEnvelope(dispatch);

async function failure(res: Response, status: number) {
	expect(res.status).toBe(status);
	expect(res.headers.get("x-request-id")).toBeTruthy();
	return errorEnvelope.parse(await res.json()).error;
}

const findingBody = {
	rule: "auth.missing-check",
	subject: "src/routes/clients.ts",
	severity: "high",
	class: "authorization",
};
const key = (n: number) =>
	({
		"idempotency-key": `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
	}) as const;

describe.skipIf(!process.env.DATABASE_URL)("the caller middleware", () => {
	afterAll(closeDb);

	it("gives a running dispatch's agent its own dispatch, without the token", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const ids = seedIds(ns);
			const { agent } = await seedRosteredAgent(tx, ids, ["domain"]);
			const own = await dispatchWithToken(tx, ids, agent, "running");
			// Another running dispatch of the same agent: not the one returned.
			await dispatchWithToken(tx, ids, agent, "running");

			const res = await call("/api/agent/dispatch", {
				headers: bearer(own.token),
			});
			expect(res.status).toBe(200);
			const body = read.parse(await res.json());
			expect(body.data).toEqual(await dispatchWire(tx, own.id));
			expect(body.data).toMatchObject({
				id: own.id,
				status: "running",
				briefRef: { moduleId: "M6", requirementIds: ["R1", "R2"] },
			});
			const text = JSON.stringify(body);
			expect(text).not.toContain(own.token.slice(8));
			expect(text).not.toContain("tokenSha256");
		});
	});

	it("answers 401 DISPATCH_CLOSED for queued, halted, complete, blocked and failed dispatches", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const ids = seedIds(ns);
			const { agent } = await seedRosteredAgent(tx, ids, ["domain"]);
			for (const status of [
				"queued",
				"halted",
				"complete",
				"blocked",
				"failed",
			] as const) {
				const { token } = await dispatchWithToken(tx, ids, agent, status);
				const error = await failure(
					await call("/api/agent/dispatch", { headers: bearer(token) }),
					401,
				);
				expect(error.code, status).toBe("DISPATCH_CLOSED");
			}
		});
	});

	it("answers 401 DISPATCH_CLOSED once the agent leaves the roster", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const ids = seedIds(ns);
			const { agent } = await seedRosteredAgent(tx, ids, ["domain"]);
			const { token } = await dispatchWithToken(tx, ids, agent, "running");
			expect(
				(await call("/api/agent/dispatch", { headers: bearer(token) })).status,
			).toBe(200);
			await tx
				.update(rosterEntry)
				.set(remove(clock))
				.where(eq(rosterEntry.id, agent.entryId));
			const error = await failure(
				await call("/api/agent/dispatch", { headers: bearer(token) }),
				401,
			);
			expect(error.code).toBe("DISPATCH_CLOSED");
		});
	});

	it("answers 401 DISPATCH_CLOSED for a bogus bearer, never 500, before the route", async () => {
		await withApi(async ({ call }) => {
			for (const value of [
				"garbage",
				`avl_dsp_${"0".repeat(64)}`,
				"avl_dsp_",
			]) {
				for (const path of ["/api/agent/dispatch", "/api/no-such-route"]) {
					const error = await failure(
						await call(path, { headers: bearer(value) }),
						401,
					);
					expect(error.code, `${value} ${path}`).toBe("DISPATCH_CLOSED");
				}
			}
		});
	});

	it("answers 403 AGENT_NOT_PERMITTED when the family forbids the route, and writes nothing", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const ids = seedIds(ns);
			const { agent, missionId } = await seedRosteredAgent(tx, ids, [
				"domain",
				"api-surface",
			]);
			const { token } = await dispatchWithToken(tx, ids, agent, "running");
			const error = await failure(
				await call("/api/agent/findings", {
					method: "POST",
					body: findingBody,
					headers: { ...bearer(token), ...key(1) },
				}),
				403,
			);
			expect(error.code).toBe("AGENT_NOT_PERMITTED");
			expect(
				await tx.select().from(finding).where(eq(finding.missionId, missionId)),
			).toEqual([]);
		});
	});

	it("refuses a running agent every operator route, and writes nothing", async () => {
		await withApi(async ({ call, tx, ns }) => {
			const ids = seedIds(ns);
			const { agent } = await seedRosteredAgent(tx, ids, ["security-review"]);
			const { token } = await dispatchWithToken(tx, ids, agent, "running");
			const before = await tx.select().from(client);
			for (const [method, path, body] of [
				["GET", "/api/clients", undefined],
				["POST", "/api/clients", { name: "Meridian" }],
				["POST", `/api/missions/${agent.missionId}/start`, undefined],
				["GET", "/api/no-such-route", undefined],
			] as const) {
				const error = await failure(
					await call(path, { method, body, headers: bearer(token) }),
					403,
				);
				expect(error.code, `${method} ${path}`).toBe("AGENT_NOT_PERMITTED");
			}
			expect(await tx.select().from(client)).toEqual(before);
		});
	});

	it("takes the bearer over a valid session cookie", async () => {
		await withApi(async ({ signIn, call, tx, ns }) => {
			const ids = seedIds(ns);
			const { agent } = await seedRosteredAgent(tx, ids, ["domain"]);
			const { token } = await dispatchWithToken(tx, ids, agent, "halted");
			await signIn();
			expect((await call("/api/clients")).status).toBe(200);
			const error = await failure(
				await call("/api/clients", { headers: bearer(token) }),
				401,
			);
			expect(error.code).toBe("DISPATCH_CLOSED");
		});
	});

	it("resolves the runner credential to the system caller, which reaches no route yet", async () => {
		await withApi(
			async ({ call }) => {
				for (const path of ["/api/clients", "/api/agent/dispatch"]) {
					const error = await failure(
						await call(path, { headers: bearer(RUNNER) }),
						403,
					);
					expect(error.code, path).toBe("FORBIDDEN");
				}
				const wrong = await failure(
					await call("/api/clients", {
						headers: bearer(`avl_run_${"x".repeat(32)}`),
					}),
					401,
				);
				expect(wrong.code).toBe("UNAUTHENTICATED");
			},
			{ runnerCredential: RUNNER },
		);
	});

	it("answers 401 UNAUTHENTICATED for a runner credential when no runner is configured", async () => {
		await withApi(async ({ call }) => {
			const error = await failure(
				await call("/api/clients", { headers: bearer(RUNNER) }),
				401,
			);
			expect(error.code).toBe("UNAUTHENTICATED");
		});
	});

	it("leaves the operator path unchanged without a bearer", async () => {
		await withApi(async ({ signIn, call }) => {
			for (const path of ["/api/clients", "/api/no-such-route"]) {
				const error = await failure(await call(path), 401);
				expect(error.code, path).toBe("UNAUTHENTICATED");
			}
			await signIn();
			expect((await call("/api/clients")).status).toBe(200);
			const missing = await failure(await call("/api/no-such-route"), 404);
			expect(missing.code).toBe("NOT_FOUND");
		});
	});

	it("answers an operator session on an agent route 403 FORBIDDEN", async () => {
		await withApi(async ({ signIn, call }) => {
			await signIn();
			const read = await failure(await call("/api/agent/dispatch"), 403);
			expect(read.code).toBe("FORBIDDEN");
			const write = await failure(
				await call("/api/agent/findings", {
					method: "POST",
					body: findingBody,
					headers: key(2),
				}),
				403,
			);
			expect(write.code).toBe("FORBIDDEN");
		});
	});
});
