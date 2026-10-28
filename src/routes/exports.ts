import { tsr } from "@ts-rest/serverless/fetch";
import { and, count, desc, eq } from "drizzle-orm";
import { exportContract, page, parseGitHubRepoUrl } from "../contract";
import { ok } from "../contract/shared/envelope";
import { logActivity } from "../db/activity";
import { directPushAllowed } from "../db/repo-policy";
import { connection, exportTable } from "../db/schema";
import { live } from "../db/schema/columns";
import { type Tx, withTx } from "../db/tx";
import { sha256Of } from "../gateways/blob";
import type { BranchTree } from "../gateways/repo-source";
import type {
	FoundPullRequest,
	OpenedPullRequest,
	PullRequestRequest,
	PushRequest,
} from "../gateways/repo-writer";
import { requestSha256 } from "../lib/canonical";
import { PACKAGE_HASH_VERSION } from "../lib/export";
import {
	type BlastRadius,
	checkDeliverable,
	computeBlastRadius,
	type PushTarget,
} from "../lib/export/delivery";
import { localTree } from "../lib/export/tree";
import { ApiError } from "../middleware/errors";
import { exportLifecycle } from "./export-lifecycle";
import {
	closedDispatches,
	DELIVERY_WINDOW_MS,
	deliveryPackage,
	dispatchBriefs,
	type ExportDeps,
	type ExportManifest,
	type ExportRow,
	gateRunById,
	hiddenAs,
	latestGateRun,
	liveMission,
	missionSource,
	prBody,
	prBranch,
	precondition,
	REPLAYED,
	refusalError,
	render,
	rosterWritablePaths,
	type ShippedGateRun,
	type Target,
	toWire,
	zipOf,
} from "./export-support";
import { type GateRunPayload, resultOfRun } from "./gate";
import { connectionRefused, usableConnection } from "./intake";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	toPage,
} from "./shared";

/**
 * Modules 10 and 11 (J, 2026-10-22). A preview renders the latest gate run
 * and records what delivering it would do; a create renders it again, runs
 * the delivery guards, and delivers: a zip inside the request, a pull
 * request or a push written to GitHub after its row is recorded.
 */
export function exportRoutes(deps: ExportDeps) {
	const { moveStatus, current, recordPullRequest } = exportLifecycle(deps);
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
			credentialRef: string;
			owner: string;
			repo: string;
			tree: BranchTree;
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
				credentialRef: conn.credentialRef,
				owner: repo.owner,
				repo: repo.repo,
				tree,
			};
		}
		// A push's branch and its repo's policy, for checkDirectPush.
		const push: PushTarget | null =
			body.target === "github_push" && github
				? {
						branch: github.tree.branch,
						defaultBranch: github.tree.defaultBranch,
						allowDirectPushToDefault: await directPushAllowed(
							tx,
							github.owner,
							github.repo,
						),
					}
				: null;

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
			push,
		};
	}

	function gateRunWire(run: {
		id: string;
		payload: GateRunPayload;
	}): ShippedGateRun {
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
		if (
			(prior.versionManifest as ExportManifest | null)?.requestSha256 !== hash
		) {
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

	/** Where a GitHub export goes, through its connection, checked again now. */
	async function prTarget(row: ExportRow) {
		if (!row.connectionId)
			throw new Error(`export ${row.id} has no connection`);
		const [conn] = await deps
			.db()
			.select()
			.from(connection)
			.where(eq(connection.id, row.connectionId));
		if (!conn) throw new Error(`export ${row.id}'s connection is gone`);
		const target = (row.blastRadius as BlastRadius | null)?.target;
		if (!target) throw new Error(`export ${row.id} has no target`);
		if (!deps.repos.hasCredential(conn.credentialRef)) {
			throw connectionRefused(
				"connection_credential_missing",
				`The credential ${conn.credentialRef} is not set on this server`,
				conn.id,
			);
		}
		return {
			owner: target.owner,
			repo: target.repo,
			credentialRef: conn.credentialRef,
		};
	}

	/**
	 * Writes the PR outside any transaction, then records what happened:
	 * pr-open with its PR, or failed with the reason, which is also thrown.
	 * When GitHub stops answering (EXTERNAL_GITHUB), the PR may exist all the
	 * same, so its branch is looked up first: found, it is recorded; the
	 * lookup unanswered too, the export stays delivering for refresh to
	 * settle, and only an answer that it is not there fails it. A status
	 * another request recorded meanwhile is never overwritten.
	 */
	async function deliverPullRequest(
		ctx: RequestContext,
		row: ExportRow,
		request: PullRequestRequest,
		engagementId: string | null,
	): Promise<ExportRow> {
		let opened: OpenedPullRequest;
		try {
			opened = await deps.repoWriter.openPullRequest(request);
		} catch (e) {
			const err =
				e instanceof ApiError
					? e
					: new ApiError(
							"EXTERNAL_GITHUB",
							`Delivering to ${request.owner}/${request.repo} failed`,
						);
			const refused = () =>
				new ApiError(err.code, err.message, {
					details: { exportId: row.id } as never,
				});
			if (err.code === "EXTERNAL_GITHUB") {
				let pr: FoundPullRequest | null;
				try {
					pr = await deps.repoWriter.findPullRequest({
						owner: request.owner,
						repo: request.repo,
						credentialRef: request.credentialRef,
						head: request.head,
					});
				} catch {
					throw refused();
				}
				if (pr) {
					const found = pr;
					return withTx(deps.db(), (tx) =>
						recordPullRequest(tx, ctx, row, found, engagementId),
					);
				}
			}
			const failed = await withTx(deps.db(), (tx) =>
				moveStatus(tx, ctx, row, "failed", engagementId, {
					failureCode: err.code,
					failureMessage: err.message,
				}),
			);
			// Another request settled it meanwhile, from GitHub: that stands.
			if (!failed) return withTx(deps.db(), (tx) => current(tx, row.id));
			throw refused();
		}
		return withTx(deps.db(), async (tx) => {
			const moved = await moveStatus(tx, ctx, row, "pr-open", engagementId, {
				prStatus: "open",
				prNumber: opened.number,
				prUrl: opened.url,
				prHeadRef: opened.branch,
				prCommitSha: opened.commitSha,
			});
			return moved ?? current(tx, row.id);
		});
	}

	/**
	 * Pushes outside any transaction, then records done with the new tip, or
	 * failed with the reason, which is also thrown. The writer reads the tip
	 * once when GitHub stops answering mid-move, so a push that landed is
	 * done. A status another request recorded meanwhile is never overwritten.
	 */
	async function deliverPush(
		ctx: RequestContext,
		row: ExportRow,
		request: PushRequest,
		engagementId: string | null,
	): Promise<ExportRow> {
		let pushed: { commitSha: string };
		try {
			pushed = await deps.repoWriter.pushToBranch(request);
		} catch (e) {
			const err =
				e instanceof ApiError
					? e
					: new ApiError(
							"EXTERNAL_GITHUB",
							`Pushing to ${request.owner}/${request.repo} failed`,
						);
			const failed = await withTx(deps.db(), (tx) =>
				moveStatus(tx, ctx, row, "failed", engagementId, {
					failureCode: err.code,
					failureMessage: err.message,
				}),
			);
			if (!failed) return withTx(deps.db(), (tx) => current(tx, row.id));
			throw new ApiError(err.code, err.message, {
				details: { exportId: row.id } as never,
			});
		}
		return withTx(deps.db(), async (tx) => {
			const moved = await moveStatus(tx, ctx, row, "done", engagementId, {
				pushedCommitSha: pushed.commitSha,
			});
			return moved ?? current(tx, row.id);
		});
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
					push: p.push,
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
					// A GitHub target's branch tip, read just now by prepare.
					currentBaseSha: p.github?.tree.commitSha ?? null,
					packageSha: p.rendered.sha256,
					packageHashVersion: PACKAGE_HASH_VERSION,
					push: p.push,
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

				const manifest: ExportManifest = {
					gateRun,
					dispatches: p.dispatches,
					package: { files: p.files, deletes: p.deletes },
					violations: p.violations,
					blocked: null,
					requestSha256: hash,
				};
				if (p.github) {
					const base = p.github.tree.commitSha;
					if (base === null) {
						throw new ApiError(
							"EMPTY_REPOSITORY",
							`${p.github.owner}/${p.github.repo} has no commit on ${p.github.tree.branch} to open a pull request against`,
						);
					}
					// Recorded as delivering before GitHub is written, so a
					// resend with this key finds it, whatever happens next.
					const row = await insert(
						tx,
						ctx,
						{
							missionId: m.id,
							sprintN: m.sprintN,
							idempotencyKey: key,
							targetKind: body.target,
							connectionId: p.github.connectionId,
							status: "delivering",
							dryRun: false,
							previewExportId: preview?.id ?? null,
							baseRef: p.github.tree.branch,
							baseCommitSha: base,
							blastRadius: p.blastRadius,
							versionManifest: manifest,
							packageSha256: p.rendered.sha256,
							packageHashVersion: PACKAGE_HASH_VERSION,
						},
						m.engagementId,
					);
					const title = `AVEL: ${m.type} sprint ${m.sprintN}`;
					const files = p.rendered.pkg.files.map((f) => ({
						path: f.path,
						mode: f.mode,
						bytes: f.bytes,
						blobSha: f.blobSha,
					}));
					const message = `${title}\n\nGate run ${gateRun.id}, ${gateRun.result}. Package ${p.rendered.sha256}.`;
					if (body.target === "github_push") {
						const push: PushRequest = {
							owner: p.github.owner,
							repo: p.github.repo,
							credentialRef: p.github.credentialRef,
							base: { branch: p.github.tree.branch, commitSha: base },
							files,
							deletes: [...p.rendered.pkg.deletes],
							message,
						};
						return {
							replayed: false,
							row,
							push,
							engagementId: m.engagementId,
						};
					}
					const deliver: PullRequestRequest = {
						owner: p.github.owner,
						repo: p.github.repo,
						credentialRef: p.github.credentialRef,
						base: { branch: p.github.tree.branch, commitSha: base },
						head: prBranch(row),
						files,
						deletes: [...p.rendered.pkg.deletes],
						message,
						title,
						body: prBody(m, gateRun, p.rendered.sha256, row.id),
					};
					return {
						replayed: false,
						row,
						deliver,
						engagementId: m.engagementId,
					};
				}
				const zip = zipOf(p.rendered.pkg);
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
			if ("push" in result && result.push) {
				const row = await deliverPush(
					ctx,
					result.row,
					result.push,
					result.engagementId,
				);
				return { status: 201, body: ok(toWire(row)) };
			}
			if ("deliver" in result && result.deliver) {
				const row = await deliverPullRequest(
					ctx,
					result.row,
					result.deliver,
					result.engagementId,
				);
				return { status: 201, body: ok(toWire(row)) };
			}
			return { status: 201, body: ok(toWire(result.row)) };
		},

		refresh: async ({ params }, ctx) => {
			const { found, m } = await withTx(deps.db(), async (tx) => {
				const [row] = await tx
					.select()
					.from(exportTable)
					.where(eq(exportTable.id, params.id));
				if (!row) throw notFound("export", params.id);
				const mission = await liveMission(tx, row.missionId).catch(
					hiddenAs("export", params.id),
				);
				if (
					row.targetKind !== "github_pr" ||
					row.dryRun ||
					(row.status !== "pr-open" && row.status !== "delivering")
				) {
					throw precondition(
						"export_not_pr_open",
						row.dryRun
							? "A preview has no pull request to read"
							: `A ${row.status} ${row.targetKind} export has no pull request to read`,
						{ missionId: row.missionId },
					);
				}
				return { found: row, m: mission };
			});
			// GitHub is read outside any transaction.
			const target = await prTarget(found);
			const pr = await deps.repoWriter.findPullRequest({
				...target,
				head: found.prHeadRef ?? prBranch(found),
			});
			if (!pr) {
				// A delivery that never opened its PR (GitHub refused or did not
				// answer, and the lookup could not tell) fails once no delivery
				// could still be writing it. Younger, it is left to finish.
				const since =
					deps.clock.now().getTime() - found.statusChangedAt.getTime();
				if (found.status !== "delivering" || since < DELIVERY_WINDOW_MS) {
					return { status: 200, body: ok(toWire(found)) };
				}
				const settled = await withTx(deps.db(), async (tx) => {
					const failed = await moveStatus(
						tx,
						ctx,
						found,
						"failed",
						m.engagementId,
						{
							failureCode: "EXTERNAL_GITHUB",
							failureMessage: `GitHub has no pull request for this export ${Math.round(since / 60_000)} minutes after delivery began. Deliver it again.`,
						},
					);
					return failed ?? current(tx, found.id);
				});
				return { status: 200, body: ok(toWire(settled)) };
			}
			const updated = await withTx(deps.db(), (tx) =>
				recordPullRequest(tx, ctx, found, pr, m.engagementId),
			);
			return { status: 200, body: ok(toWire(updated)) };
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
				body: page(items.map(toWire), nextCursor, counted?.total ?? 0),
			};
		},
	});
}
