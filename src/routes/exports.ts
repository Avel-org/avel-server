import { tsr } from "@ts-rest/serverless/fetch";
import { exportContract } from "../contract/export";
import type { RepoSource } from "../gateways/repo-source";
import type { RoomSourceResolver } from "../rooms/sources";
import type { RequestContext, RouteDeps } from "./shared";

type ExportDeps = RouteDeps & {
	repos: RepoSource;
	roomSources: RoomSourceResolver;
};

const notBuilt = () => {
	throw new Error("export routes: contract only, handlers not built yet");
};

/** Modules 10 and 11, slice 1. Contract only for now: every handler throws. */
export function exportRoutes(_deps: ExportDeps) {
	return tsr.platformContext<RequestContext>().router(exportContract, {
		preview: notBuilt,
		create: notBuilt,
		get: notBuilt,
		list: notBuilt,
	});
}
