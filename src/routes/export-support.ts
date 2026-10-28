import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { type ExportWire, resolveWritablePaths } from "../contract";
import type { exportTargetKind } from "../contract/mission";
import type { PreconditionReason } from "../contract/shared/errors";
import {
	activityLog,
	agentTemplate,
	client,
	completionReport,
	dispatch,
	engagement,
	type exportTable,
	mission,
	rosterEntry,
} from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor, Tx } from "../db/tx";
import type { RepoSource } from "../gateways/repo-source";
import type { RepoWriter } from "../gateways/repo-writer";
import {
	type ClosedDispatch,
	type DispatchBrief,
	type ExportRefusal,
	ExportRefused,
	packageSha256,
	readPackage,
	rebuildIntegrationCommit,
	renderPackage,
	writeZip,
	zipEntries,
} from "../lib/export";
import type {
	BlastRadius,
	DeliveryPackage,
	GuardResult,
	Violation,
} from "../lib/export/delivery";
import { ApiError } from "../middleware/errors";
import { IntegrationRefused } from "../rooms/snapshot";
import type { RoomSourceResolver } from "../rooms/sources";
import { briefSha256 } from "../runner/brief";
import { missionRoomSource } from "../runner/room-source";
import type { GateRunPayload } from "./gate";
import { notFound, type RouteDeps } from "./shared";

// What the export routes, the lifecycle and the zip route share: the wire,
// the pull request's shape, refusals, and rendering a gate run.

export type ExportDeps = RouteDeps & {
	repos: RepoSource;
	repoWriter: RepoWriter;
	roomSources: RoomSourceResolver;
};

/**
 * How long a delivering export with no PR on GitHub is left for its
 * delivery to finish before refresh fails it. Ten minutes `[hypothesis]`:
 * a package is tens of files, written in seconds.
 */
export const DELIVERY_WINDOW_MS = 10 * 60_000;

/**
 * A github_pr export's branch, from what the export already records, so a
 * refresh after a crash can find the PR it opened. The export's own id ends
 * it: createRef never repoints a branch, so a second export of the same
 * package needs a branch of its own.
 */
export function prBranch(row: {
	id: string;
	missionId: string;
	sprintN: number;
	packageSha256: string | null;
}): string {
	return `avel/${row.missionId.slice(0, 8)}-s${row.sprintN}-${(row.packageSha256 ?? "").slice(0, 12)}-${row.id.slice(-12)}`;
}

/** The gate run an export ships. A manifest always names one. */
export type ShippedGateRun = NonNullable<ExportWire["gateRun"]>;

/** The PR's description: what shipped and the evidence behind it. */
export function prBody(
	m: { id: string; type: string; sprintN: number },
	gateRun: ShippedGateRun,
	packageSha256: string,
	exportId: string,
): string {
	return [
		`Delivered by AVEL: ${m.type}, sprint ${m.sprintN}.`,
		"",
		`- Gate run \`${gateRun.id}\`: **${gateRun.result}**`,
		`- Receipt sha256 \`${gateRun.receiptSha256}\``,
		`- Integration commit \`${gateRun.commitSha}\` on base \`${gateRun.baseSha}\``,
		`- Package sha256 \`${packageSha256}\``,
		`- Mission \`${m.id}\`, export \`${exportId}\``,
		"",
		"Each dispatch's brief is under `.avel/dispatches/`. Whether this merges is your decision.",
	].join("\n");
}

export type Target = (typeof exportTargetKind)["_output"];

/** Header on a replayed export (DATA-CONTRACTS-V2.md, Idempotency). */
export const REPLAYED = "idempotency-replayed";

/**
 * What an export row keeps in version_manifest: the gate run it ships, the
 * dispatch inputs its integration commit was rebuilt from (so the zip route
 * renders the same bytes later, whatever closed since), the package's file
 * list and violations, and the request hash replays are told apart by.
 */
export type ExportManifest = {
	gateRun: ShippedGateRun;
	dispatches: ClosedDispatch[];
	package: Pick<NonNullable<ExportWire["package"]>, "files" | "deletes">;
	violations: Violation[];
	blocked: ExportWire["blocked"];
	requestSha256: string;
};

export type ExportRow = typeof exportTable.$inferSelect;

export const precondition = (
	reason: PreconditionReason,
	message: string,
	extra: {
		missionId?: string;
		issues?: { path: string[]; message: string }[];
	} = {},
) =>
	new ApiError("PRECONDITION_FAILED", message, {
		details: { reason, ...extra },
	});

/** Each render refusal as the precondition reason the wire carries. */
export const RENDER_REASONS: Record<ExportRefusal, PreconditionReason> = {
	symlink: "package_symlink",
	submodule: "package_submodule",
	mode_only: "package_mode_only",
	unsupported_mode: "package_unsupported_mode",
	path_not_utf8: "package_path_not_utf8",
	receipt_path_written: "package_reserved_path",
	deletes_path_written: "package_reserved_path",
	dispatch_brief_path_written: "package_reserved_path",
	integration_commit_moved: "integration_commit_moved",
	unsafe_path: "package_unsafe_path",
	duplicate_path: "package_duplicate_path",
	zip_too_large: "package_too_large",
};

/** A guard's refusal as the error a create answers with. */
export function refusalError(
	r: Extract<GuardResult, { ok: false }>,
	missionId: string,
) {
	if (r.code === "PRECONDITION_FAILED") {
		return precondition(r.reason as PreconditionReason, r.message, {
			missionId,
		});
	}
	return new ApiError(r.code, r.message, {
		details: { reason: r.reason, ...(r.details ?? {}) } as never,
	});
}

/** pr_status as the wire's state; a PR with none recorded yet is open. */
export function prState(s: string | null): "open" | "merged" | "closed" {
	return s === "merged" || s === "closed" ? s : "open";
}

export function toWire(row: ExportRow): ExportWire {
	// Null only before render (drizzle/0056): pending, rendering, or failed first.
	const m = row.versionManifest as ExportManifest | null;
	return {
		id: row.id,
		missionId: row.missionId,
		sprintN: row.sprintN,
		targetKind: row.targetKind,
		connectionId: row.connectionId,
		status: row.status,
		statusChangedAt: row.statusChangedAt.toISOString(),
		dryRun: row.dryRun,
		previewExportId: row.previewExportId,
		gateRun: m?.gateRun ?? null,
		baseRef: row.baseRef,
		baseCommitSha: row.baseCommitSha,
		package:
			m === null
				? null
				: {
						sha256: row.packageSha256 as string,
						hashVersion: row.packageHashVersion as number,
						files: m.package.files,
						deletes: m.package.deletes,
					},
		violations: m?.violations ?? [],
		blastRadius: (row.blastRadius as BlastRadius | null) ?? null,
		blocked: m?.blocked ?? null,
		pullRequest:
			row.prNumber !== null &&
			row.prUrl !== null &&
			row.prHeadRef !== null &&
			row.prCommitSha !== null
				? {
						number: row.prNumber,
						url: row.prUrl,
						branch: row.prHeadRef,
						commitSha: row.prCommitSha,
						state: prState(row.prStatus),
					}
				: null,
		push:
			row.pushedCommitSha !== null && row.baseRef !== null
				? { branch: row.baseRef, commitSha: row.pushedCommitSha }
				: null,
		failure:
			row.failureCode !== null && row.failureMessage !== null
				? { code: row.failureCode, message: row.failureMessage }
				: null,
		zip:
			row.snapshotSha256 && row.snapshotBytes
				? { sha256: row.snapshotSha256, bytes: row.snapshotBytes }
				: null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * The mission as its detail route sees it: live, and for a client mission,
 * with a live engagement and client (as the dispatch routes read it). An
 * export, and every brief it carries, is hidden whenever its mission is.
 */
export async function liveMission(db: Executor | Tx, id: string) {
	const [m] = await db
		.select({
			id: mission.id,
			type: mission.type,
			status: mission.status,
			sprintN: mission.sprintN,
			engagementId: mission.engagementId,
			origin: mission.origin,
			clientId: client.id,
		})
		.from(mission)
		.leftJoin(
			engagement,
			and(eq(engagement.id, mission.engagementId), live(engagement)),
		)
		.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(mission.id, id), live(mission)));
	if (!m || (m.origin === "client" && m.clientId === null)) {
		throw notFound("mission", id);
	}
	return m;
}

/** An export whose mission is hidden answers as a missing export. */
export const hiddenAs = (entity: string, id: string) => (err: unknown) => {
	if (err instanceof ApiError && err.code === "NOT_FOUND") {
		throw notFound(entity, id);
	}
	throw err;
};

export const gateRuns = (missionId: string) =>
	and(
		eq(activityLog.missionId, missionId),
		eq(activityLog.action, "mission.gate_run"),
	);

/** The mission's newest gate run, in the gate's own order (at desc, id desc). */
export async function latestGateRun(db: Executor | Tx, missionId: string) {
	const [row] = await db
		.select({ id: activityLog.id, payload: activityLog.payload })
		.from(activityLog)
		.where(gateRuns(missionId))
		.orderBy(desc(activityLog.at), desc(activityLog.id))
		.limit(1);
	return row ? { id: row.id, payload: row.payload as GateRunPayload } : null;
}

export async function gateRunById(
	db: Executor | Tx,
	missionId: string,
	id: string,
) {
	const [row] = await db
		.select({ id: activityLog.id, payload: activityLog.payload })
		.from(activityLog)
		.where(and(gateRuns(missionId), eq(activityLog.id, id)));
	if (!row) throw notFound("gate run", id);
	return { id: row.id, payload: row.payload as GateRunPayload };
}

/** Each dispatch the gate's integration plan reads: closed, with a report. */
export async function closedDispatches(
	db: Executor | Tx,
	missionId: string,
): Promise<ClosedDispatch[]> {
	const rows = await db
		.select({
			id: dispatch.id,
			closedAt: dispatch.closedAt,
			status: completionReport.status,
			resultCommitSha: completionReport.resultCommitSha,
		})
		.from(dispatch)
		.leftJoin(completionReport, eq(completionReport.dispatchId, dispatch.id))
		.where(eq(dispatch.missionId, missionId))
		.orderBy(asc(dispatch.id));
	return rows.flatMap((d) =>
		d.status !== null && d.closedAt !== null
			? [
					{
						id: d.id,
						status: d.status,
						closedAt: d.closedAt.toISOString(),
						resultCommitSha: d.resultCommitSha,
					},
				]
			: [],
	);
}

/**
 * The frozen brief of each complete dispatch the integration commit is
 * built from, for .avel/dispatches/ (J, 2026-10-22). A dispatch started
 * with no brief has none to ship. A brief whose text no longer hashes to
 * the sha frozen beside it is a DETERMINISM_VIOLATION: the package would
 * not carry what the agent was told.
 */
export async function dispatchBriefs(
	db: Executor | Tx,
	dispatches: readonly ClosedDispatch[],
): Promise<DispatchBrief[]> {
	const ids = dispatches
		.filter((d) => d.status === "complete")
		.map((d) => d.id);
	if (ids.length === 0) return [];
	const rows = await db
		.select({
			id: dispatch.id,
			briefMd: dispatch.briefMd,
			briefSha256: dispatch.briefSha256,
		})
		.from(dispatch)
		.where(inArray(dispatch.id, ids))
		.orderBy(asc(dispatch.id));
	return rows.flatMap((r) => {
		if (r.briefMd === null) return [];
		if (briefSha256(r.briefMd) !== r.briefSha256) {
			throw new ApiError(
				"DETERMINISM_VIOLATION",
				"A dispatch's brief no longer matches the hash frozen at its start",
				{ details: { dispatchId: r.id } as never },
			);
		}
		return [{ dispatchId: r.id, briefMd: r.briefMd }];
	});
}

/** Where the package may write: every live roster entry's writable paths, plus .avel/ (added by the blast radius). */
export async function rosterWritablePaths(
	db: Executor | Tx,
	missionId: string,
) {
	const rows = await db
		.select({
			writablePaths: rosterEntry.writablePaths,
			templatePaths: agentTemplate.writablePaths,
		})
		.from(rosterEntry)
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.where(and(eq(rosterEntry.missionId, missionId), live(rosterEntry)))
		.orderBy(asc(rosterEntry.id));
	const paths = new Set<string>();
	for (const r of rows) {
		for (const p of resolveWritablePaths(r, {
			writablePaths: r.templatePaths,
		})) {
			paths.add(p);
		}
	}
	return [...paths];
}

/** The mission's local clone, or source_unavailable. */
export async function missionSource(
	db: Executor | Tx,
	roomSources: RoomSourceResolver,
	missionId: string,
) {
	const found = await missionRoomSource(db, missionId);
	if ("issue" in found) {
		throw precondition(
			"source_unavailable",
			"The mission's source cannot be found",
			{
				missionId,
				issues: [{ path: [...found.issue.path], message: found.issue.message }],
			},
		);
	}
	const resolved = await roomSources.resolve(found.source);
	if (!resolved.ok) {
		throw precondition(
			"source_unavailable",
			"The mission's source cannot be found",
			{
				missionId,
				issues: [
					{ path: [...resolved.issue.path], message: resolved.issue.message },
				],
			},
		);
	}
	return { source: found.source, repoPath: resolved.repoPath };
}

/**
 * The package for one gate run: its integration commit rebuilt from the
 * dispatch inputs, then the files that commit changed from the base, the
 * receipt, the dispatch briefs, and the hash. Render refusals answer as precondition reasons.
 */
export async function render(
	repoPath: string,
	run: { payload: GateRunPayload },
	dispatches: readonly ClosedDispatch[],
	briefs: readonly DispatchBrief[],
	missionId: string,
) {
	const { baseSha, commitSha, receipt } = run.payload;
	try {
		await rebuildIntegrationCommit({
			source: repoPath,
			baseSha,
			dispatches,
			recordedSha: commitSha,
		});
		const read = await readPackage(repoPath, baseSha, commitSha);
		const pkg = renderPackage({ read, receipt, briefs });
		return { pkg, sha256: packageSha256(pkg) };
	} catch (e) {
		if (e instanceof ExportRefused) {
			const path = typeof e.details.path === "string" ? e.details.path : null;
			throw precondition(RENDER_REASONS[e.details.reason], e.message, {
				missionId,
				issues: path
					? [{ path: ["package", path], message: e.details.reason }]
					: [],
			});
		}
		if (e instanceof IntegrationRefused) {
			// The dispatches no longer build the commit the gate judged.
			throw precondition(
				e.details.reason === "integration_conflict"
					? "integration_conflict"
					: "integration_commit_moved",
				"The gate's integration commit cannot be rebuilt from the mission's dispatches. Gate again.",
				{ missionId },
			);
		}
		throw e;
	}
}

export function deliveryPackage(
	pkg: Awaited<ReturnType<typeof render>>["pkg"],
): DeliveryPackage {
	return {
		files: pkg.files.map((f) => ({
			path: f.path,
			mode: f.mode,
			bytes: f.bytes.byteLength,
			blobSha: f.blobSha,
		})),
		deletes: pkg.deletes,
	};
}

export function zipOf(pkg: Awaited<ReturnType<typeof render>>["pkg"]) {
	try {
		return writeZip(zipEntries(pkg));
	} catch (e) {
		if (e instanceof ExportRefused) {
			throw precondition(RENDER_REASONS[e.details.reason], e.message);
		}
		throw e;
	}
}
