import { initContract } from "@ts-rest/core";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Auth, Operator } from "../../src/auth";
import type { DispatchStatus, Role } from "../../src/contract";
import type { Executor } from "../../src/db/tx";
import { sha256Hex } from "../../src/lib/tokens";
import {
	type Caller,
	type CallerVariables,
	type DispatchTokenLookup,
	type DispatchTokenMatch,
	resolveCaller,
} from "../../src/middleware/caller";
import { toErrorEnvelope } from "../../src/middleware/errors";
import { actorOf } from "../../src/routes/shared";

const c = initContract();
const ok = { 200: z.object({}) };

// A contract of its own, so each kind of declaration can be called.
const test = c.router({
	dispatch: {
		method: "GET",
		path: "/api/agent/dispatch",
		responses: ok,
		metadata: {
			agent: { resource: "dispatch", verb: "read", own: "dispatch" },
		},
	},
	finding: {
		method: "POST",
		path: "/api/agent/findings",
		body: z.object({}),
		responses: ok,
		metadata: { agent: { resource: "finding", verb: "act", own: "mission" } },
	},
	runner: {
		method: "POST",
		path: "/api/runner/tokens",
		body: z.object({}),
		responses: ok,
		metadata: { system: true },
	},
	operatorOnly: { method: "GET", path: "/api/clients", responses: ok },
});

const OPERATOR: Operator = {
	id: "00000000-0000-4000-8000-0000000000aa",
	githubId: "1",
	githubLogin: "op",
	name: "Op",
	email: "op@example.com",
};

const RUNNER = `avl_run_${"r".repeat(32)}`;
const TOKEN = `avl_dsp_${"d".repeat(64)}`;

function match(status: DispatchStatus, roles: Role[]): DispatchTokenMatch {
	return {
		dispatch: {
			id: "00000000-0000-4000-8000-000000000001",
			rosterEntryId: "00000000-0000-4000-8000-000000000002",
			missionId: "00000000-0000-4000-8000-000000000003",
			status,
			briefRef: null,
		},
		rosterEntry: {
			id: "00000000-0000-4000-8000-000000000002",
			missionId: "00000000-0000-4000-8000-000000000003",
			agentTemplateId: "00000000-0000-4000-8000-000000000004",
		},
		roles,
	};
}

/**
 * The middleware on a bare Hono app, every route echoing the caller it
 * set. The session check answers from `session`.
 */
function build(
	options: {
		found?: DispatchTokenMatch;
		runner?: string | null;
		session?: boolean;
		preview?: boolean;
	} = {},
) {
	const looked: string[] = [];
	const lookup: DispatchTokenLookup = async (_exec, sha) => {
		looked.push(sha);
		return sha === sha256Hex(TOKEN) ? (options.found ?? null) : null;
	};
	const auth = {
		operatorFor: async () =>
			options.session
				? { operator: OPERATOR, setCookies: [] }
				: { refused: "no_session" },
	} as unknown as Auth;
	const app = new Hono<{ Variables: CallerVariables }>();
	app.use(
		"/api/*",
		resolveCaller({
			auth,
			preview: options.preview ?? false,
			db: () => ({}) as Executor,
			contract: test,
			dispatchByToken: lookup,
			runnerCredentialSha256:
				options.runner === undefined
					? sha256Hex(RUNNER)
					: options.runner && sha256Hex(options.runner),
		}),
	);
	app.all("/api/*", (ctx) => ctx.json({ caller: ctx.get("caller") ?? null }));
	app.onError((err, ctx) => {
		const { status, body } = toErrorEnvelope(err, "req", () => {});
		return ctx.json(body, status as ContentfulStatusCode);
	});
	const call = async (
		path: string,
		init: { method?: string; bearer?: string; authorization?: string } = {},
	) => {
		const authorization =
			init.authorization ??
			(init.bearer === undefined ? undefined : `Bearer ${init.bearer}`);
		const res = await app.request(path, {
			method: init.method ?? "GET",
			headers: authorization ? { authorization } : {},
		});
		const body = (await res.json()) as {
			caller?: Caller | null;
			error?: { code: string };
		};
		return { status: res.status, caller: body.caller, code: body.error?.code };
	};
	return { call, looked };
}

describe("resolveCaller: a dispatch token", () => {
	it("resolves a running dispatch to its agent", async () => {
		const found = match("running", ["spec-judgment"]);
		const { call, looked } = build({ found });
		const res = await call("/api/agent/dispatch", { bearer: TOKEN });
		expect(res).toEqual({
			status: 200,
			caller: { kind: "agent", ...found },
			code: undefined,
		});
		// Looked up by hash, never by the token itself.
		expect(looked).toEqual([sha256Hex(TOKEN)]);
	});

	it("answers 401 DISPATCH_CLOSED for every status but running", async () => {
		for (const status of [
			"queued",
			"complete",
			"blocked",
			"failed",
			"halted",
		] as const) {
			const { call } = build({ found: match(status, ["domain"]) });
			const res = await call("/api/agent/dispatch", { bearer: TOKEN });
			expect(res, status).toMatchObject({
				status: 401,
				code: "DISPATCH_CLOSED",
			});
		}
	});

	it("answers 401 DISPATCH_CLOSED for an unknown or bogus bearer, before the route", async () => {
		const { call } = build({ found: match("running", ["domain"]) });
		for (const bearer of [`avl_dsp_${"e".repeat(64)}`, "garbage", "a.b.c"]) {
			for (const path of ["/api/agent/dispatch", "/api/no-such-route"]) {
				expect(await call(path, { bearer }), bearer).toMatchObject({
					status: 401,
					code: "DISPATCH_CLOSED",
				});
			}
		}
	});

	it("answers 403 AGENT_NOT_PERMITTED when the families forbid the route", async () => {
		const { call } = build({ found: match("running", ["domain"]) });
		const res = await call("/api/agent/findings", {
			method: "POST",
			bearer: TOKEN,
		});
		expect(res).toMatchObject({ status: 403, code: "AGENT_NOT_PERMITTED" });
		const judge = build({ found: match("running", ["security-review"]) });
		expect(
			await judge.call("/api/agent/findings", {
				method: "POST",
				bearer: TOKEN,
			}),
		).toMatchObject({ status: 200, caller: { kind: "agent" } });
	});

	it("answers 403 AGENT_NOT_PERMITTED on an undeclared or unknown route", async () => {
		const { call } = build({ found: match("running", ["spec-judgment"]) });
		for (const [method, path] of [
			["GET", "/api/clients"],
			["POST", "/api/runner/tokens"],
			["GET", "/api/no-such-route"],
			["DELETE", "/api/agent/dispatch"],
		] as const) {
			expect(await call(path, { method, bearer: TOKEN }), path).toMatchObject({
				status: 403,
				code: "AGENT_NOT_PERMITTED",
			});
		}
	});
});

describe("resolveCaller: the runner credential", () => {
	it("resolves to the system caller on a route declaring system", async () => {
		const { call, looked } = build();
		const res = await call("/api/runner/tokens", {
			method: "POST",
			bearer: RUNNER,
		});
		expect(res).toEqual({
			status: 200,
			caller: { kind: "system" },
			code: undefined,
		});
		expect(looked).toEqual([]);
	});

	it("answers 403 FORBIDDEN on any route not declaring system", async () => {
		const { call } = build();
		for (const path of ["/api/clients", "/api/agent/dispatch", "/api/nope"]) {
			expect(await call(path, { bearer: RUNNER }), path).toMatchObject({
				status: 403,
				code: "FORBIDDEN",
			});
		}
	});

	it("answers 401 UNAUTHENTICATED for a wrong credential, or when none is configured", async () => {
		const wrong = build();
		expect(
			await wrong.call("/api/runner/tokens", {
				method: "POST",
				bearer: `avl_run_${"s".repeat(32)}`,
			}),
		).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
		const none = build({ runner: null });
		expect(
			await none.call("/api/runner/tokens", { method: "POST", bearer: RUNNER }),
		).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
		expect(wrong.looked).toEqual([]);
	});
});

describe("resolveCaller: no bearer", () => {
	it("is the operator, through requireOperator", async () => {
		const { call } = build({ session: true });
		expect(await call("/api/clients")).toEqual({
			status: 200,
			caller: { kind: "operator", operator: OPERATOR },
			code: undefined,
		});
	});

	it("answers 401 without a session, unknown routes included", async () => {
		const { call } = build();
		for (const path of ["/api/clients", "/api/no-such-route"]) {
			expect(await call(path), path).toMatchObject({
				status: 401,
				code: "UNAUTHENTICATED",
			});
		}
	});

	it("treats a non-Bearer authorization header as none", async () => {
		const { call, looked } = build();
		expect(
			await call("/api/clients", { authorization: `Basic ${TOKEN}` }),
		).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
		expect(looked).toEqual([]);
	});

	it("sets no caller on a dev-preview read with no session", async () => {
		const { call } = build({ preview: true });
		expect(await call("/api/clients")).toEqual({
			status: 200,
			caller: null,
			code: undefined,
		});
	});

	it("ignores a bearer on a public path", async () => {
		const { call, looked } = build();
		expect(await call("/api/health", { bearer: "garbage" })).toMatchObject({
			status: 200,
			caller: null,
		});
		expect(looked).toEqual([]);
	});
});

describe("actorOf", () => {
	it("names the user, the roster entry, or neither", () => {
		const agent = { kind: "agent", ...match("running", ["domain"]) } as const;
		expect(actorOf({ kind: "operator", operator: OPERATOR })).toEqual({
			actorKind: "operator",
			actorUserId: OPERATOR.id,
		});
		expect(actorOf(agent)).toEqual({
			actorKind: "agent",
			actorRosterEntryId: agent.rosterEntry.id,
		});
		expect(actorOf({ kind: "system" })).toEqual({ actorKind: "system" });
	});
});
