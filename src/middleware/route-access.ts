import { type AppRoute, type AppRouter, isAppRoute } from "@ts-rest/core";
import type { RouteAccess } from "../contract/agent";

/** One contract route and what it declares for non-operator callers. */
export type DeclaredRoute = {
	method: string;
	path: string;
	access: RouteAccess;
};

/** Every route in a contract router, nested routers included, in declaration order. */
export function contractRoutes(router: AppRouter): AppRoute[] {
	return Object.values(router).flatMap((entry) =>
		isAppRoute(entry) ? [entry] : contractRoutes(entry),
	);
}

/** A route's access metadata, or none. Only `agent` and `system` are read. */
export function accessOf(route: AppRoute): RouteAccess {
	const metadata = route.metadata as RouteAccess | undefined;
	return {
		...(metadata?.agent ? { agent: metadata.agent } : {}),
		...(metadata?.system === true ? { system: true as const } : {}),
	};
}

const segments = (path: string) => path.replace(/\/+$/, "").split("/");

/**
 * Finds the contract route a request will reach, so the caller middleware
 * can read its declaration before ts-rest routes it. A path matches a
 * pattern of the same length whose every segment is equal or a `:param`.
 * When several match, the one with the most literal segments wins, so
 * /api/agent/dispatch/current would beat /api/agent/dispatch/:id.
 */
export function routeMatcher(router: AppRouter) {
	const routes = contractRoutes(router).map((route) => ({
		method: route.method,
		path: route.path,
		parts: segments(route.path),
		access: accessOf(route),
	}));
	return (method: string, path: string): DeclaredRoute | undefined => {
		const parts = segments(path);
		let best: (typeof routes)[number] | undefined;
		let bestLiterals = -1;
		for (const route of routes) {
			if (route.method !== method.toUpperCase()) continue;
			if (route.parts.length !== parts.length) continue;
			let literals = 0;
			const matches = route.parts.every((part, i) => {
				if (part.startsWith(":")) return (parts[i] ?? "") !== "";
				literals += 1;
				return part === parts[i];
			});
			if (matches && literals > bestLiterals) {
				best = route;
				bestLiterals = literals;
			}
		}
		return best
			? { method: best.method, path: best.path, access: best.access }
			: undefined;
	};
}
