import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { exportTable } from "../db/schema";
import { sha256Of } from "../gateways/blob";
import { ApiError } from "../middleware/errors";
import {
	dispatchBriefs,
	type ExportDeps,
	type ExportManifest,
	gateRunById,
	hiddenAs,
	liveMission,
	missionSource,
	render,
	zipOf,
} from "./export-support";
import { notFound, operatorOfRaw } from "./shared";

/**
 * GET /api/exports/:id/zip: a done zip's bytes, outside the contract because
 * they are bytes, not an envelope. They are never stored: the route renders
 * the export's gate run again from the dispatch inputs the export recorded,
 * and refuses (DETERMINISM_VIOLATION) bytes whose sha256 is not the one the
 * export recorded.
 */
export function exportZipRoute(deps: ExportDeps) {
	return async (ctx: Context) => {
		operatorOfRaw(ctx, {
			unauthenticated: "Exports need a signed-in operator",
			forbidden: "Only an operator may download an export",
		});
		const db = deps.db();
		const id = ctx.req.param("id");
		const [row] = await db
			.select()
			.from(exportTable)
			.where(eq(exportTable.id, id ?? ""));
		if (
			!row ||
			row.targetKind !== "zip" ||
			row.dryRun ||
			row.status !== "done" ||
			!row.snapshotSha256
		) {
			throw notFound("zip export", id ?? "");
		}
		await liveMission(db, row.missionId).catch(
			hiddenAs("zip export", id ?? ""),
		);
		const manifest = row.versionManifest as ExportManifest;
		const run = await gateRunById(db, row.missionId, manifest.gateRun.id);
		const { repoPath } = await missionSource(
			db,
			deps.roomSources,
			row.missionId,
		);
		const rendered = await render(
			repoPath,
			run,
			manifest.dispatches,
			await dispatchBriefs(db, manifest.dispatches),
			row.missionId,
		);
		const zip = zipOf(rendered.pkg);
		const sha = sha256Of(zip);
		if (sha !== row.snapshotSha256) {
			throw new ApiError(
				"DETERMINISM_VIOLATION",
				"The zip rendered again is not the one this export recorded: either the render is not deterministic, or the dispatch commits in the source clone changed.",
				{ details: { recorded: row.snapshotSha256, rendered: sha } as never },
			);
		}
		const name = `avel-${row.missionId.slice(0, 8)}-sprint-${row.sprintN}-${(row.packageSha256 ?? "").slice(0, 12)}.zip`;
		return new Response(zip, {
			status: 200,
			headers: {
				"content-type": "application/zip",
				"content-length": String(zip.byteLength),
				"content-disposition": `attachment; filename="${name}"`,
				"x-content-type-options": "nosniff",
				"cache-control": "private, no-store",
			},
		});
	};
}
