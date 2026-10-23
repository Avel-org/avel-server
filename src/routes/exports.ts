import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import type { Operator } from "../auth";
import {
	type ExportWire,
	exportContract,
	parseGitHubRepoUrl,
	resolveWritablePaths,
} from "../contract";
import type { exportTargetKind } from "../contract/mission";
import { ok } from "../contract/shared/envelope";
import type { PreconditionReason } from "../contract/shared/errors";
import { logActivity } from "../db/activity";
import {
	activityLog,
	agentTemplate,
	client,
	completionReport,
	connection,
	dispatch,
	engagement,
	exportTable,
	mission,
	rosterEntry,
} from "../db/schema";
import { live } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { sha256Of } from "../gateways/blob";
import type { RepoSource } from "../gateways/repo-source";
import { requestSha256 } from "../lib/canonical";
import {
	type ClosedDispatch,
	type DispatchBrief,
	type ExportRefusal,
	ExportRefused,
	PACKAGE_HASH_VERSION,
	packageSha256,
	readPackage,
	rebuildIntegrationCommit,
	renderPackage,
	writeZip,
	zipEntries,
} from "../lib/export";
import {
	type BlastRadius,
	checkDeliverable,
	computeBlastRadius,
	type DeliveryPackage,
	type GuardResult,
	type RemoteTree,
	type Violation,
} from "../lib/export/delivery";
import { localTree } from "../lib/export/tree";
import type { Caller } from "../middleware/caller";
import { ApiError } from "../middleware/errors";
import { IntegrationRefused } from "../rooms/snapshot";
import type { RoomSourceResolver } from "../rooms/sources";
import { briefSha256 } from "../runner/brief";
import { missionRoomSource } from "../runner/room-source";
import { type GateRunPayload, resultOfRun } from "./gate";
import { connectionRefused, usableConnection } from "./intake";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type ExportDeps = RouteDeps & {
	repos: RepoSource;
	roomSources: RoomSourceResolver;
};

type Target = (typeof exportTargetKind)["_output"];

/** Header on a replayed export (DATA-CONTRACTS-V2.md, Idempotency). */
const REPLAYED = "idempotency-replayed";

/**
 * What an export row keeps in version_manifest: the gate run it ships, the
 * dispatch inputs its integration commit was rebuilt from (so the zip route
 * renders the same bytes later, whatever closed since), the package's file
 * list and violations, and the request hash replays are told apart by.
 */
type ExportManifest = {
	gateRun: ExportWire["gateRun"];
	dispatches: ClosedDispatch[];
	package: Pick<ExportWire["package"], "files" | "deletes">;
	violations: Violation[];
	blocked: ExportWire["blocked"];
	requestSha256: string;
};

type ExportRow = typeof exportTable.$inferSelect;

const precondition = (
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
const RENDER_REASONS: Record<ExportRefusal, PreconditionReason> = {
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
function refusalError(
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

function toWire(row: ExportRow): ExportWire {
	const m = row.versionManifest as ExportManifest;
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
		gateRun: m.gateRun,
		baseRef: row.baseRef,
		baseCommitSha: row.baseCommitSha,
		package: {
			sha256: row.packageSha256 as string,
			hashVersion: row.packageHashVersion as number,
			files: m.package.files,
			deletes: m.package.deletes,
		},
		violations: m.violations,
		blastRadius: (row.blastRadius as BlastRadius | null) ?? null,
		blocked: m.blocked,
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
async function liveMission(db: Executor | Tx, id: string) {
	const [m] = await db
		.select({
			id: mission.id,
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
const hiddenAs = (entity: string, id: string) => (err: unknown) => {
	if (err instanceof ApiError && err.code === "NOT_FOUND") {
		throw notFound(entity, id);
	}
	throw err;
};

const gateRuns = (missionId: string) =>
	and(
		eq(activityLog.missionId, missionId),
		eq(activityLog.action, "mission.gate_run"),
	);

/** The mission's newest gate run, in the gate's own order (at desc, id desc). */
async function latestGateRun(db: Executor | Tx, missionId: string) {
	const [row] = await db
		.select({ id: activityLog.id, payload: activityLog.payload })
		.from(activityLog)
		.where(gateRuns(missionId))
		.orderBy(desc(activityLog.at), desc(activityLog.id))
		.limit(1);
	return row ? { id: row.id, payload: row.payload as GateRunPayload } : null;
}

async function gateRunById(db: Executor | Tx, missionId: string, id: string) {
	const [row] = await db
		.select({ id: activityLog.id, payload: activityLog.payload })
		.from(activityLog)
		.where(and(gateRuns(missionId), eq(activityLog.id, id)));
	if (!row) throw notFound("gate run", id);
	return { id: row.id, payload: row.payload as GateRunPayload };
}

/** Each dispatch the gate's integration plan reads: closed, with a report. */
async function closedDispatches(
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
async function dispatchBriefs(
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
async function rosterWritablePaths(db: Executor | Tx, missionId: string) {
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
async function missionSource(
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
async function render(
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

function deliveryPackage(
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

function zipOf(pkg: Awaited<ReturnType<typeof render>>["pkg"]) {
	try {
		return writeZip(zipEntries(pkg));
	} catch (e) {
		if (e instanceof ExportRefused) {
			throw precondition(RENDER_REASONS[e.details.reason], e.message);
		}
		throw e;
	}
}

/**
 * Modules 10 and 11, slice 1 (J, 2026-10-22). A preview renders the latest
 * gate run and records what delivering it would do; a create renders it
 * again, runs the delivery guards, and delivers. Zip only for now: GitHub
 * targets can be previewed and not yet created. Everything runs inside the
 * request, so an export's status is final when its route answers.
 */
export function exportRoutes(deps: ExportDeps) {
	/**
	 * Everything a preview and a create share: the gate run, the source, the
	 * render, the violations, and for a GitHub target its branch tree.
	 */
	async function prepare(
		tx: Tx,
		m: Awaited<ReturnType<typeof liveMission>>,
		body: { target: Target; connectionId?: string; ref?: string },
		run: { id: string; payload: GateRunPayload },
	) {
		const { source, repoPath } = await missionSource(
			tx,
			deps.roomSources,
			m.id,
		);

		let github: {
			connectionId: string;
			owner: string;
			repo: string;
			tree: RemoteTree & { branch: string };
		} | null = null;
		if (body.target !== "zip") {
			const repo =
				source.kind === "repo" ? parseGitHubRepoUrl(source.repoUrl) : null;
			if (!repo || !m.engagementId) {
				throw precondition(
					"export_target_repo_missing",
					"Only a client mission has a repository to deliver to",
					{ missionId: m.id },
				);
			}
			const connectionId = body.connectionId as string;
			const [row] = await tx
				.select()
				.from(connection)
				.where(and(eq(connection.id, connectionId), live(connection)));
			const conn = usableConnection(
				row,
				connectionId,
				m.engagementId,
				repo,
				deps.clock.now(),
			);
			if (!deps.repos.hasCredential(conn.credentialRef)) {
				throw connectionRefused(
					"connection_credential_missing",
					`The credential ${conn.credentialRef} is not set on this server`,
					conn.id,
				);
			}
			const tree = await deps.repos.tree({
				owner: repo.owner,
				repo: repo.repo,
				branch: body.ref,
				credentialRef: conn.credentialRef,
			});
			github = {
				connectionId: conn.id,
				owner: repo.owner,
				repo: repo.repo,
				tree,
			};
		}

		const dispatches = await closedDispatches(tx, m.id);
		const rendered = await render(
			repoPath,
			run,
			dispatches,
			await dispatchBriefs(tx, dispatches),
			m.id,
		);
		const pkg = deliveryPackage(rendered.pkg);
		const policy = {
			writablePaths: await rosterWritablePaths(tx, m.id),
			// RepoPolicy has no protected-path list yet: the built-in ones apply.
			protectedPaths: [],
		};
		const computedAt = deps.clock.now().toISOString();
		const { baseSha } = run.payload;

		// Against the mission's base: each file's change, and a zip's violations.
		const onBase = computeBlastRadius(
			pkg,
			await localTree(repoPath, baseSha),
			policy,
			{
				computedAt,
				baseRef: baseSha,
				target: { owner: "", repo: "", branch: "" },
			},
		);
		const created = new Set(onBase.create.map((f) => f.path));
		const files = pkg.files.map((f) => ({
			...f,
			change: created.has(f.path)
				? ("create" as const)
				: ("overwrite" as const),
		}));

		const blastRadius = github
			? computeBlastRadius(pkg, github.tree, policy, {
					computedAt,
					baseRef: github.tree.branch,
					target: {
						owner: github.owner,
						repo: github.repo,
						branch: github.tree.branch,
					},
				})
			: null;
		return {
			dispatches,
			rendered,
			files,
			deletes: [...pkg.deletes],
			violations: blastRadius ? blastRadius.violations : onBase.violations,
			blastRadius,
			github,
		};
	}

	function gateRunWire(run: {
		id: string;
		payload: GateRunPayload;
	}): ExportWire["gateRun"] {
		return {
			id: run.id,
			result: resultOfRun(run.payload),
			commitSha: run.payload.commitSha,
			baseSha: run.payload.baseSha,
			receiptSha256: run.payload.receiptSha256,
		};
	}

	/** The export this key already made, as a replay, or 409 when the body differs. */
	async function replay(tx: Tx, key: string, hash: string) {
		const [prior] = await tx
			.select()
			.from(exportTable)
			.where(eq(exportTable.idempotencyKey, key));
		if (!prior) return null;
		if ((prior.versionManifest as ExportManifest).requestSha256 !== hash) {
			throw new ApiError(
				"IDEMPOTENCY_REPLAY",
				"This idempotency key was used with a different body",
			);
		}
		return prior;
	}

	async function insert(
		tx: Tx,
		ctx: RequestContext,
		values: Omit<
			typeof exportTable.$inferInsert,
			"id" | "createdAt" | "updatedAt" | "statusChangedAt"
		>,
		engagementId: string | null,
	) {
		const operator = operatorOf(ctx);
		const now = deps.clock.now();
		const [row] = await tx
			.insert(exportTable)
			.values({
				id: deps.ids.next(),
				...values,
				statusChangedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		if (!row) throw new Error("an export insert returned no row");
		await logActivity(tx, deps, {
			actorKind: "operator",
			actorUserId: operator.id,
			action: "export.created",
			entityType: "export",
			entityId: row.id,
			missionId: row.missionId,
			engagementId,
			requestId: ctx.requestId,
			payload: {
				exportId: row.id,
				targetKind: row.targetKind,
				dryRun: row.dryRun,
				status: row.status,
				packageSha256: row.packageSha256,
				gateRunId: (row.versionManifest as ExportManifest).gateRun.id,
			},
		});
		return row;
	}

	return tsr.platformContext<RequestContext>().router(exportContract, {
		preview: async ({ headers, body }, ctx) => {
			const key = headers["idempotency-key"];
			const hash = requestSha256({ route: "preview", ...body });
			const result = await withTx(deps.db(), async (tx) => {
				const prior = await replay(tx, key, hash);
				if (prior) return { replayed: true, row: prior };
				const m = await liveMission(tx, body.missionId);
				if (m.status !== "active") {
					throw precondition(
						"mission_not_active",
						`A ${m.status} mission is not exported`,
						{
							missionId: m.id,
						},
					);
				}
				const run = await latestGateRun(tx, m.id);
				if (!run) {
					throw precondition(
						"gate_not_run",
						"The mission has no gate run to export",
						{
							missionId: m.id,
						},
					);
				}
				const p = await prepare(tx, m, body, run);
				const gateRun = gateRunWire(run);
				const baseCommitSha = p.github ? p.github.tree.commitSha : null;
				// What a create from this preview would meet: the preview itself is
				// the linked one, so only the gate and the violations can refuse.
				const verdict = checkDeliverable({
					gateResult: gateRun.result,
					violations: p.violations,
					target: body.target,
					missionId: m.id,
					preview: {
						exportId: "self",
						missionId: m.id,
						baseCommitSha,
						packageSha: p.rendered.sha256,
						packageHashVersion: PACKAGE_HASH_VERSION,
					},
					currentBaseSha: baseCommitSha,
					packageSha: p.rendered.sha256,
					packageHashVersion: PACKAGE_HASH_VERSION,
				});
				const manifest: ExportManifest = {
					gateRun,
					dispatches: p.dispatches,
					package: { files: p.files, deletes: p.deletes },
					violations: p.violations,
					blocked: verdict.ok
						? null
						: {
								code: verdict.code as never,
								reason: verdict.reason,
								message: verdict.message,
							},
					requestSha256: hash,
				};
				const row = await insert(
					tx,
					ctx,
					{
						missionId: m.id,
						sprintN: m.sprintN,
						idempotencyKey: key,
						targetKind: body.target,
						connectionId: p.github?.connectionId ?? null,
						status: "previewed",
						dryRun: true,
						baseRef: p.github?.tree.branch ?? null,
						baseCommitSha,
						blastRadius: p.blastRadius,
						versionManifest: manifest,
						packageSha256: p.rendered.sha256,
						packageHashVersion: PACKAGE_HASH_VERSION,
					},
					m.engagementId,
				);
				return { replayed: false, row };
			});
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(toWire(result.row)) };
			}
			return { status: 201, body: ok(toWire(result.row)) };
		},

		create: async ({ headers, body }, ctx) => {
			const key = headers["idempotency-key"];
			const hash = requestSha256({ route: "create", ...body });
			const result = await withTx(deps.db(), async (tx) => {
				const prior = await replay(tx, key, hash);
				if (prior) return { replayed: true, row: prior };
				const m = await liveMission(tx, body.missionId);
				if (m.status !== "active") {
					throw precondition(
						"mission_not_active",
						`A ${m.status} mission is not exported`,
						{
							missionId: m.id,
						},
					);
				}
				const run = await gateRunById(tx, m.id, body.gateRunId);
				const latest = await latestGateRun(tx, m.id);
				if (latest && latest.id !== run.id) {
					throw precondition(
						"gate_run_not_latest",
						"A newer gate run exists. Export the latest run.",
						{ missionId: m.id },
					);
				}
				if (body.target !== "zip") {
					throw precondition(
						"export_target_not_built",
						"Delivery to GitHub is not built yet. Export a zip.",
						{ missionId: m.id },
					);
				}
				let preview: ExportRow | null = null;
				if (body.previewExportId) {
					const [found] = await tx
						.select()
						.from(exportTable)
						.where(
							and(
								eq(exportTable.id, body.previewExportId),
								eq(exportTable.dryRun, true),
								eq(exportTable.status, "previewed"),
							),
						);
					if (!found) throw notFound("preview", body.previewExportId);
					preview = found;
				}

				const p = await prepare(tx, m, body, run);
				const gateRun = gateRunWire(run);
				const verdict = checkDeliverable({
					gateResult: gateRun.result,
					violations: p.violations,
					target: body.target,
					missionId: m.id,
					preview: preview
						? {
								exportId: preview.id,
								missionId: preview.missionId,
								baseCommitSha: preview.baseCommitSha,
								packageSha: preview.packageSha256 as string,
								packageHashVersion: preview.packageHashVersion as number,
							}
						: null,
					currentBaseSha: null,
					packageSha: p.rendered.sha256,
					packageHashVersion: PACKAGE_HASH_VERSION,
				});
				// A preview of another target approves nothing here. Checked after
				// the gate, the violations and the preview's presence, which come first.
				const early: readonly string[] = [
					"gate_pass_not_verified",
					"gate_failed",
					"blast_radius_violation",
					"preview_required",
				];
				if (!verdict.ok && early.includes(verdict.reason)) {
					throw refusalError(verdict, m.id);
				}
				if (preview && preview.targetKind !== body.target) {
					throw precondition(
						"preview_target_mismatch",
						`The preview is of a ${preview.targetKind} export, not a ${body.target}`,
						{ missionId: m.id },
					);
				}
				if (!verdict.ok) throw refusalError(verdict, m.id);

				const zip = zipOf(p.rendered.pkg);
				const manifest: ExportManifest = {
					gateRun,
					dispatches: p.dispatches,
					package: { files: p.files, deletes: p.deletes },
					violations: p.violations,
					blocked: null,
					requestSha256: hash,
				};
				const row = await insert(
					tx,
					ctx,
					{
						missionId: m.id,
						sprintN: m.sprintN,
						idempotencyKey: key,
						targetKind: body.target,
						connectionId: null,
						status: "done",
						dryRun: false,
						previewExportId: preview?.id ?? null,
						baseRef: null,
						baseCommitSha: null,
						blastRadius: null,
						versionManifest: manifest,
						packageSha256: p.rendered.sha256,
						packageHashVersion: PACKAGE_HASH_VERSION,
						snapshotSha256: sha256Of(zip),
						snapshotBytes: zip.byteLength,
					},
					m.engagementId,
				);
				return { replayed: false, row };
			});
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(toWire(result.row)) };
			}
			return { status: 201, body: ok(toWire(result.row)) };
		},

		get: async ({ params }) => {
			const [row] = await deps
				.db()
				.select()
				.from(exportTable)
				.where(eq(exportTable.id, params.id));
			if (!row) throw notFound("export", params.id);
			await liveMission(deps.db(), row.missionId).catch(
				hiddenAs("export", params.id),
			);
			return { status: 200, body: ok(toWire(row)) };
		},

		list: async ({ params, query }) => {
			const db = deps.db();
			await liveMission(db, params.id);
			const rows = await db
				.select()
				.from(exportTable)
				.where(
					and(
						eq(exportTable.missionId, params.id),
						after(exportTable, query.cursor),
					),
				)
				.orderBy(desc(exportTable.createdAt), desc(exportTable.id))
				.limit(query.limit + 1);
			const [counted] = await db
				.select({ total: count() })
				.from(exportTable)
				.where(eq(exportTable.missionId, params.id));
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map(toWire),
					meta: { nextCursor, total: counted?.total ?? 0 },
				},
			};
		},
	});
}

function operatorFrom(ctx: Context): Operator {
	const caller = ctx.get("caller") as Caller | undefined;
	if (!caller) {
		throw new ApiError("UNAUTHENTICATED", "Exports need a signed-in operator");
	}
	if (caller.kind !== "operator") {
		throw new ApiError("FORBIDDEN", "Only an operator may download an export");
	}
	return caller.operator;
}

/**
 * GET /api/exports/:id/zip: a done zip's bytes, outside the contract because
 * they are bytes, not an envelope. They are never stored: the route renders
 * the export's gate run again from the dispatch inputs the export recorded,
 * and refuses (DETERMINISM_VIOLATION) bytes whose sha256 is not the one the
 * export recorded.
 */
export function exportZipRoute(deps: ExportDeps) {
	return async (ctx: Context) => {
		operatorFrom(ctx);
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
