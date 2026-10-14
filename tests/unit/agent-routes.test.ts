import { initContract } from "@ts-rest/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	contract,
	FINDING_SEVERITIES,
	FINDING_STATUSES,
	type RouteAccess,
} from "../../src/contract";
import { findingSeverity, findingStatus } from "../../src/db/schema";
import {
	accessOf,
	contractRoutes,
	routeMatcher,
} from "../../src/middleware/route-access";

const c = initContract();
const ok = { 200: z.object({}) };

describe("route declarations", () => {
	const routes = contractRoutes(contract);

	it("walks every route, nested routers included", () => {
		const paths = routes.map((r) => `${r.method} ${r.path}`);
		expect(paths).toContain("GET /api/health");
		expect(paths).toContain("GET /api/agent/dispatch");
		expect(paths).toContain(
			"POST /api/agent-templates/:id/identity/regenerate",
		);
		expect(new Set(paths).size).toBe(paths.length);
	});

	// DATA-CONTRACTS-V2.md, Dispatch: operator-only actions are never
	// declared, so no family table entry can grant them to an agent.
	it("declares agent access only under /api/agent/*", () => {
		const outside = routes
			.filter((r) => accessOf(r).agent && !r.path.startsWith("/api/agent/"))
			.map((r) => `${r.method} ${r.path}`);
		expect(outside).toEqual([]);
	});

	it("declares every /api/agent/* route, so none refuses by omission", () => {
		const agentRoutes = routes.filter((r) => r.path.startsWith("/api/agent/"));
		expect(agentRoutes.map((r) => [r.path, accessOf(r).agent])).toEqual([
			[
				"/api/agent/dispatch",
				{ resource: "dispatch", verb: "read", own: "dispatch" },
			],
			[
				"/api/agent/findings",
				{ resource: "finding", verb: "act", own: "mission" },
			],
			[
				"/api/agent/report",
				{ resource: "completion_report", verb: "act", own: "dispatch" },
			],
		]);
	});

	it("lets the runner reach no route yet", () => {
		expect(routes.filter((r) => accessOf(r).system)).toEqual([]);
	});

	it("reads only agent and a literal true system from metadata", () => {
		const route = c.query({
			method: "GET",
			path: "/x",
			responses: ok,
			metadata: { system: "yes", other: 1 } as unknown as RouteAccess,
		});
		expect(accessOf(route)).toEqual({});
	});
});

describe("routeMatcher", () => {
	const declared = (resource: "dispatch" | "finding") =>
		({ agent: { resource, verb: "read", own: "dispatch" } }) as const;
	const test = c.router({
		current: {
			method: "GET",
			path: "/api/agent/dispatch",
			responses: ok,
			metadata: declared("dispatch"),
		},
		byId: {
			method: "GET",
			path: "/api/agent/dispatch/:id",
			responses: ok,
			metadata: declared("finding"),
		},
		latest: {
			method: "GET",
			path: "/api/agent/dispatch/latest",
			responses: ok,
			metadata: { system: true },
		},
		report: {
			method: "GET",
			path: "/api/agent/:id/report",
			responses: ok,
		},
		nested: c.router({
			write: {
				method: "POST",
				path: "/api/agent/dispatch",
				body: z.object({}),
				responses: ok,
			},
		}),
	});
	const at = routeMatcher(test);

	it("tells a route from the same path with a param", () => {
		expect(at("GET", "/api/agent/dispatch")?.path).toBe("/api/agent/dispatch");
		expect(at("GET", "/api/agent/dispatch/abc")?.path).toBe(
			"/api/agent/dispatch/:id",
		);
		expect(at("GET", "/api/agent/dispatch/abc")?.access).toEqual(
			declared("finding"),
		);
	});

	it("prefers a literal segment over a param", () => {
		expect(at("GET", "/api/agent/dispatch/latest")?.access).toEqual({
			system: true,
		});
	});

	it("matches on method, nested routers included", () => {
		expect(at("POST", "/api/agent/dispatch")?.path).toBe("/api/agent/dispatch");
		expect(at("POST", "/api/agent/dispatch")?.access).toEqual({});
		expect(at("post", "/api/agent/dispatch")?.method).toBe("POST");
		expect(at("DELETE", "/api/agent/dispatch")).toBeUndefined();
	});

	it("finds nothing for another length, an empty param or another path", () => {
		expect(at("GET", "/api/agent/dispatch/a/b")).toBeUndefined();
		// A trailing slash is dropped; an empty middle segment fills no param.
		expect(at("GET", "/api/agent/dispatch//")?.path).toBe(
			"/api/agent/dispatch",
		);
		expect(at("GET", "/api/agent/x/report")?.path).toBe(
			"/api/agent/:id/report",
		);
		expect(at("GET", "/api/agent//report")).toBeUndefined();
		expect(at("GET", "/api/agent")).toBeUndefined();
		expect(at("GET", "/api/agent/dispatches")).toBeUndefined();
	});

	it("finds the real contract's agent routes", () => {
		const real = routeMatcher(contract);
		expect(real("GET", "/api/agent/dispatch")?.access.agent?.resource).toBe(
			"dispatch",
		);
		expect(real("POST", "/api/agent/findings")?.access.agent?.verb).toBe("act");
		expect(
			real("GET", "/api/clients/00000000-0000-4000-8000-000000000001")?.path,
		).toBe("/api/clients/:id");
	});
});

describe("finding vocabulary", () => {
	it("equals the finding pgEnums", () => {
		expect(findingSeverity.enumValues).toEqual([...FINDING_SEVERITIES]);
		expect(findingStatus.enumValues).toEqual([...FINDING_STATUSES]);
	});
});
