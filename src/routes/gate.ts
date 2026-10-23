import { tsr } from "@ts-rest/serverless/fetch";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import {
	type BriefCheck,
	briefSchema,
	type GateRun,
	type GateRunSummary,
	gateContract,
	ok,
	type PlaybookGate,
	ROLE_SIDE,
	type Role,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	activityLog,
	agentTemplate,
	completionReport,
	dispatch,
	finding,
	mission,
	playbook,
	rosterEntry,
	user,
} from "../db/schema";
import { live } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import type {
	CheckRunner,
	CheckRunResult,
	RunnableCheck,
} from "../gateways/check-runner";
import { requestSha256 } from "../lib/canonical";
import {
	DECIDE_VERSION,
	type Decision,
	decide,
	type GateFinding,
	type GateReason,
	type GateResult,
	resultOf,
} from "../lib/gate";
import { GATE_CONFIG, type GateConfig } from "../lib/gate/config";
import {
	type IntegrationDispatch,
	planIntegration,
} from "../lib/gate/integration";
import {
	briefCheckFindings,
	type DependencyManifest,
	dependencyFindings,
	type JudgeRun,
	judgeCoverageFindings,
	protectedPathFindings,
	RUNNER_SOURCE,
	type SecretScanFile,
	secretScanFindings,
	specCheckFindings,
	testGlobFindings,
} from "../lib/gate/producers";
import { buildReceipt, RECEIPT_VERSION } from "../lib/gate/receipt";
import { ApiError } from "../middleware/errors";
import type { FileChange } from "../rooms/checkpoint";
import { type BlobRead, git, readBlobs } from "../rooms/git";
import {
	buildIntegrationCommit,
	dispatchChanges,
	IntegrationRefused,
	readPackageJsonScripts,
	readTree,
} from "../rooms/snapshot";
import type { RoomSourceResolver } from "../rooms/sources";
import { missionRoomSource } from "../runner/room-source";
import { activityActor, actorColumns } from "./activity";
import {
	decodeCursor,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type GateDeps = RouteDeps & {
	roomSources: RoomSourceResolver;
	/** Runs the brief's test, typecheck and command checks; null when none is installed. */
	checkRunner: CheckRunner | null;
};

/**
 * The config a run decides under: GATE_CONFIG, with `runner` an installed
 * source only when a check runner is. Without one, a runner check's not_run
 * is degraded, as before; with one, a check it did not run blocks.
 */
function configFor(runner: CheckRunner | null): GateConfig {
	return runner === null
		? GATE_CONFIG
		: {
				...GATE_CONFIG,
				availableSources: [...GATE_CONFIG.availableSources, RUNNER_SOURCE],
			};
}

/**
 * Each check that needs a runner, run against the integration commit, keyed
 * by its index in `checks`. A runner that throws leaves every check it was
 * given as an error: the run cannot be verified, and nothing passes on a
 * runner that broke.
 */
async function runChecks(
	runner: CheckRunner | null,
	source: string,
	commitSha: string,
	checks: readonly BriefCheck[],
): Promise<Map<number, CheckRunResult>> {
	const ran = new Map<number, CheckRunResult>();
	if (runner === null) return ran;
	const runnable = checks.flatMap((c, i) =>
		c.kind === "file_exists" ? [] : [{ i, check: c as RunnableCheck }],
	);
	if (runnable.length === 0) return ran;
	let results: CheckRunResult[];
	try {
		results = await runner.run({
			source,
			commitSha,
			checks: runnable.map((r) => r.check),
		});
	} catch {
		results = runnable.map(() => ({
			outcome: "error",
			exitCode: null,
			output: "",
		}));
	}
	if (results.length !== runnable.length) {
		throw new Error(
			`The check runner ${runner.id} answered ${results.length} results for ${runnable.length} checks`,
		);
	}
	runnable.forEach((r, k) => {
		ran.set(r.i, results[k] as CheckRunResult);
	});
	return ran;
}

/** Header on a replayed run (DATA-CONTRACTS-V2.md, Idempotency). */
const REPLAYED = "idempotency-replayed";

/**
 * What a mission.gate_run activity row holds. The receipt is stored as its
 * exact string, so its hash reproduces byte for byte; jsonb would rewrite it.
 */
export type GateRunPayload = {
	commitSha: string;
	baseSha: string;
	/** From decide() version 3; older rows read it from their receipt (resultOfRun). */
	result?: GateResult;
	decideVersion: number;
	receiptVersion: number;
	configSha256: string;
	receiptSha256: string;
	receipt: string;
	overrides: { findingId: string; commitSha: string; rationale: string }[];
	excludedDispatches: GateRun["excludedDispatches"];
	idempotencyKey: string | null;
	requestSha256: string;
};

const refuse = (message: string, details: Record<string, unknown>) =>
	new ApiError("PRECONDITION_FAILED", message, {
		details: details as never,
	});

/** Which side a template's roles put it on; null when none has a side. */
function sideOf(roles: readonly Role[]): string | null {
	for (const r of roles) {
		const side = ROLE_SIDE[r];
		if (side) return side;
	}
	return null;
}

/**
 * A run's result: stored on the row from decide() version 3, else read
 * from its receipt's reasons, which every version stores.
 */
export function resultOfRun(p: GateRunPayload): GateResult {
	if (p.result !== undefined) return p.result;
	return resultOf(
		(JSON.parse(p.receipt) as { decision: Pick<Decision, "reasons"> }).decision
			.reasons,
	);
}

/** A stored decision's gates; before version 3 each carried a verdict, not a result. */
type StoredGate = Omit<Decision["gates"][number], "result"> & {
	result?: GateResult;
	reasons: GateReason[];
};

/** The run's wire shape, rebuilt from its activity row. */
function toRun(
	row: { id: string; at: Date; missionId: string | null },
	p: GateRunPayload,
): GateRun {
	const receipt = JSON.parse(p.receipt) as {
		decision: Omit<Decision, "gates"> & { gates: StoredGate[] };
	};
	return {
		id: row.id,
		at: row.at.toISOString(),
		missionId: row.missionId as string,
		commitSha: p.commitSha,
		baseSha: p.baseSha,
		result: resultOfRun(p),
		decideVersion: p.decideVersion,
		receiptVersion: p.receiptVersion,
		configSha256: p.configSha256,
		receiptSha256: p.receiptSha256,
		gates: receipt.decision.gates.map((g) => ({
			gate: g.gate,
			policy: g.policy,
			result: g.result ?? resultOf(g.reasons),
			reasons: g.reasons,
		})),
		reasons: receipt.decision.reasons,
		ignoredOverrides: receipt.decision.ignoredOverrides,
		excludedDispatches: p.excludedDispatches,
		receipt: p.receipt,
	};
}

async function liveMission(db: Executor | Tx, id: string) {
	const [m] = await db
		.select({
			id: mission.id,
			status: mission.status,
			type: mission.type,
			brief: mission.brief,
			engagementId: mission.engagementId,
		})
		.from(mission)
		.where(and(eq(mission.id, id), live(mission)));
	if (!m) throw notFound("mission", id);
	return m;
}

/**
 * Module 9's gate, run by the operator (decided 2026-10-19). It judges one
 * integration commit: the mission's complete dispatches laid onto its pinned
 * commit in close order. Producers turn the commit and the mission's rows
 * into findings, decide() turns findings into a result, and the receipt
 * records all of it. No model is in this path.
 */
export function gateRoutes(deps: GateDeps) {
	async function judge(
		tx: Tx,
		m: Awaited<ReturnType<typeof liveMission>>,
		overrides: GateRunPayload["overrides"],
	) {
		if (m.status !== "active") {
			throw refuse(`A ${m.status} mission is not gated`, {
				reason: "mission_not_active",
				missionId: m.id,
			});
		}

		const [pb] = await tx
			.select({ gates: playbook.gates })
			.from(playbook)
			.where(and(eq(playbook.missionType, m.type), live(playbook)));
		const policy: PlaybookGate[] = pb?.gates ?? [];
		const brief = briefSchema.safeParse(m.brief);

		const runs = await tx
			.select({
				id: dispatch.id,
				status: dispatch.status,
				closedAt: dispatch.closedAt,
				rosterEntryId: dispatch.rosterEntryId,
				agentVersionSha256: dispatch.agentVersionSha256,
				skillsSha256: dispatch.skillsSha256,
				model: dispatch.model,
				briefSha256: dispatch.briefSha256,
				harnessVersion: dispatch.harnessVersion,
				priceVersion: dispatch.priceVersion,
				spendUsd: dispatch.spendUsd,
				createdAt: dispatch.createdAt,
				reportStatus: completionReport.status,
				resultCommitSha: completionReport.resultCommitSha,
				roles: agentTemplate.roles,
			})
			.from(dispatch)
			.innerJoin(rosterEntry, eq(rosterEntry.id, dispatch.rosterEntryId))
			.innerJoin(
				agentTemplate,
				eq(agentTemplate.id, rosterEntry.agentTemplateId),
			)
			.leftJoin(completionReport, eq(completionReport.dispatchId, dispatch.id))
			.where(eq(dispatch.missionId, m.id))
			.orderBy(asc(dispatch.id));

		const running = runs.filter(
			(d) => d.status === "queued" || d.status === "running",
		);
		if (running.length > 0) {
			throw refuse("Dispatches are still running", {
				reason: "dispatches_running",
				missionId: m.id,
				issues: running.map((d) => ({
					path: ["dispatches", d.id],
					message: d.status,
				})),
			});
		}
		const uncommitted = runs.filter(
			(d) => d.reportStatus === "complete" && d.resultCommitSha === null,
		);
		if (uncommitted.length > 0) {
			throw refuse("A complete dispatch has no result commit to judge", {
				reason: "dispatch_commit_missing",
				missionId: m.id,
				issues: uncommitted.map((d) => ({
					path: ["dispatches", d.id],
					message: "no result commit",
				})),
			});
		}

		const found = await missionRoomSource(tx, m.id);
		const resolved =
			"issue" in found
				? ({ ok: false, issue: found.issue } as const)
				: await deps.roomSources.resolve(found.source);
		if (!resolved.ok || "issue" in found) {
			const issue = resolved.ok ? null : resolved.issue;
			throw refuse("The mission's source cannot be found", {
				reason: "source_unavailable",
				missionId: m.id,
				issues: issue ? [{ path: issue.path, message: issue.message }] : [],
			});
		}
		const source = resolved.repoPath;
		const baseSha = found.source.commit;

		// Every closed dispatch with a result commit, and what it changed.
		const changesOf = new Map<string, FileChange[]>();
		for (const d of runs) {
			if (d.resultCommitSha) {
				changesOf.set(
					d.id,
					await dispatchChanges(source, baseSha, d.resultCommitSha),
				);
			}
		}
		const closed: IntegrationDispatch[] = runs
			.filter((d) => d.reportStatus !== null && d.closedAt !== null)
			.map((d) => ({
				id: d.id,
				status: d.reportStatus as IntegrationDispatch["status"],
				closedAt: (d.closedAt as Date).toISOString(),
				changes: changesOf.get(d.id) ?? [],
			}));
		const plan = planIntegration({ baseSha, dispatches: closed });
		if (!plan.ok) {
			throw refuse("Two dispatches changed the same paths", {
				reason: "integration_conflict",
				missionId: m.id,
				issues: plan.conflicts.map((c) => ({
					path: ["integration", c.path],
					message: c.dispatchIds.join(", "),
				})),
			});
		}
		if (plan.steps.length === 0) {
			throw refuse("No complete dispatch to judge", {
				reason: "nothing_to_judge",
				missionId: m.id,
			});
		}
		let commitSha: string;
		try {
			commitSha = (await buildIntegrationCommit(source, plan)).sha;
		} catch (e) {
			// Off-base commits and plan mismatches are broken invariants: a 500.
			if (e instanceof IntegrationRefused) {
				throw new Error(
					`gate ${m.id}: ${e.message} ${JSON.stringify(e.details)}`,
				);
			}
			throw e;
		}
		// Complete dispatches that changed nothing in total leave the base's
		// tree: judging it would be a receipt for work that was never done.
		const [baseTree, headTree] = await Promise.all(
			[baseSha, commitSha].map(async (sha) =>
				(await git(["rev-parse", `${sha}^{tree}`], { cwd: source })).trim(),
			),
		);
		if (baseTree === headTree) {
			throw refuse(
				"The complete dispatches changed nothing: the integration commit's tree is the base's",
				{ reason: "nothing_to_judge", missionId: m.id },
			);
		}

		const [base, head, baseScripts, headScripts] = await Promise.all([
			readTree(source, baseSha),
			readTree(source, commitSha),
			readPackageJsonScripts(source, baseSha),
			readPackageJsonScripts(source, commitSha),
		]);
		const protectedPaths = [...GATE_CONFIG.protectedPaths];
		let packageJsonScripts:
			| { base: Record<string, string>; head: Record<string, string> }
			| undefined;
		if (headScripts.kind === "unparseable") {
			protectedPaths.push("package.json");
		} else if (headScripts.kind === "scripts") {
			packageJsonScripts = {
				base: baseScripts.kind === "scripts" ? baseScripts.scripts : {},
				head: headScripts.scripts,
			};
		}

		// The security gate reads what the work added or changed, never the base's own files.
		const changed = Object.keys(head)
			.filter((p) => base[p] !== head[p])
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const blobs = await readBlobs(
			source,
			changed.flatMap((p) => [
				head[p] as string,
				...(base[p] ? [base[p]] : []),
			]),
			GATE_CONFIG.secretScan.maxBytes,
		);
		const blob = (sha: string) => blobs.get(sha) as BlobRead;
		const scanned: SecretScanFile[] = changed.map((p) => {
			const h = blob(head[p] as string);
			const b = base[p] === undefined ? null : blob(base[p]);
			return {
				path: p,
				size: h.size,
				bytes: h.bytes,
				// A base blob too large to read whole gives no lines to discount.
				base: b === null ? null : b.whole ? b.bytes : new Uint8Array(),
			};
		});
		const manifests: DependencyManifest[] = [];
		for (const p of changed) {
			if (p !== "package.json" && !p.endsWith("/package.json")) continue;
			const h = blob(head[p] as string);
			const b = base[p] === undefined ? undefined : blob(base[p]);
			manifests.push({
				path: p,
				base: b?.whole ? parseJson(b.bytes) : undefined,
				head: h.whole ? parseJson(h.bytes) : undefined,
			});
		}

		const checks = brief.success ? brief.data.checks : [];
		const ran = await runChecks(deps.checkRunner, source, commitSha, checks);
		const findings: GateFinding[] = [
			...specCheckFindings(m.brief, commitSha),
			...secretScanFindings(scanned, commitSha, GATE_CONFIG.secretScan),
			...dependencyFindings(manifests, commitSha),
			...briefCheckFindings(checks, head, base, commitSha, ran),
			...protectedPathFindings({
				protectedPaths,
				base,
				head,
				commitSha,
				packageJsonScripts,
			}),
		];
		for (const d of runs) {
			const changes = changesOf.get(d.id);
			if (!changes) continue;
			findings.push(
				...testGlobFindings({
					dispatchId: d.id,
					roles: d.roles,
					changes,
					testGlobs: GATE_CONFIG.testGlobs,
					commitSha,
				}),
			);
		}

		// Judges: each judge-side roster entry with its latest dispatch.
		const judgeEntries = await tx
			.select({ id: rosterEntry.id, roles: agentTemplate.roles })
			.from(rosterEntry)
			.innerJoin(
				agentTemplate,
				eq(agentTemplate.id, rosterEntry.agentTemplateId),
			)
			.where(
				and(
					eq(rosterEntry.missionId, m.id),
					live(rosterEntry),
					eq(rosterEntry.active, true),
				),
			)
			.orderBy(asc(rosterEntry.id));
		const latest = new Map<string, (typeof runs)[number]>();
		for (const d of [...runs].sort(
			(a, b) =>
				a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
		)) {
			latest.set(d.rosterEntryId, d);
		}
		const judges: JudgeRun[] = judgeEntries
			.filter((e) => sideOf(e.roles) === "judge")
			.map((e) => {
				const d = latest.get(e.id);
				return {
					rosterEntryId: e.id,
					dispatch: d
						? {
								id: d.id,
								report: d.reportStatus ? { status: d.reportStatus } : null,
							}
						: null,
				};
			});
		const missionFindings = await tx
			.select()
			.from(finding)
			.where(eq(finding.missionId, m.id))
			.orderBy(asc(finding.id));
		findings.push(
			...judgeCoverageFindings({
				judges,
				findings: missionFindings,
				gate: GATE_CONFIG.judgeCoverageGate,
				commitSha,
			}),
			...missionFindings.map(
				(f): GateFinding => ({
					kind: "judge",
					id: f.id,
					gate: GATE_CONFIG.judgeCoverageGate,
					source: "judge",
					commitSha,
					subject: f.subject,
					status: f.status,
					severity: f.severity,
					operatorSeverity: null,
				}),
			),
		);

		const decision = decide(findings, policy, overrides, {
			commitSha,
			availableSources: configFor(deps.checkRunner).availableSources,
		});
		const judgeIds = new Set(
			judges.flatMap((j) => (j.dispatch ? [j.dispatch.id] : [])),
		);
		return {
			commitSha,
			baseSha,
			decision,
			findings,
			excluded: plan.excluded,
			judges: runs
				.filter((d) => judgeIds.has(d.id))
				.map((d) => ({
					dispatchId: d.id,
					agentVersionSha256: d.agentVersionSha256,
					skillsSha256: d.skillsSha256,
					model: d.model,
					status: d.status,
				})),
			dispatches: runs.map((d) => ({
				id: d.id,
				briefSha256: d.briefSha256,
				harnessVersion: d.harnessVersion,
				priceVersion: d.priceVersion,
				spendUsd: Number(d.spendUsd),
			})),
		};
	}

	const gateRuns = (missionId: string) =>
		and(
			eq(activityLog.missionId, missionId),
			eq(activityLog.action, "mission.gate_run"),
		);

	return tsr.platformContext<RequestContext>().router(gateContract, {
		run: async ({ params, headers, body }, ctx) => {
			const operator = operatorOf(ctx);
			const key = headers["idempotency-key"] ?? null;
			const hash = requestSha256(body);
			const result = await withTx(deps.db(), async (tx) => {
				const m = await liveMission(tx, params.id);
				// One gate run per mission at a time: a second waits, then runs.
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${`gate:${m.id}`}))`,
				);
				if (key) {
					const [prior] = await tx
						.select({
							id: activityLog.id,
							at: activityLog.at,
							missionId: activityLog.missionId,
							payload: activityLog.payload,
						})
						.from(activityLog)
						.where(
							and(
								gateRuns(m.id),
								sql`${activityLog.payload}->>'idempotencyKey' = ${key}`,
							),
						);
					if (prior) {
						const p = prior.payload as GateRunPayload;
						if (p.requestSha256 !== hash) {
							throw new ApiError(
								"IDEMPOTENCY_REPLAY",
								"This idempotency key was used with a different body",
							);
						}
						return { replayed: true, run: toRun(prior, p) };
					}
				}
				const judged = await judge(tx, m, body.overrides);
				const receipt = buildReceipt({
					missionId: m.id,
					commitSha: judged.commitSha,
					baseSha: judged.baseSha,
					decision: judged.decision,
					config: configFor(deps.checkRunner),
					runner: deps.checkRunner?.id ?? null,
					findings: judged.findings,
					overrides: body.overrides.map((o) => ({
						...o,
						operatorId: operator.id,
					})),
					judges: judged.judges,
					dispatches: judged.dispatches,
				});
				const parsed = JSON.parse(receipt.json) as {
					config: { sha256: string };
				};
				const payload: GateRunPayload = {
					commitSha: judged.commitSha,
					baseSha: judged.baseSha,
					result: judged.decision.result,
					decideVersion: DECIDE_VERSION,
					receiptVersion: RECEIPT_VERSION,
					configSha256: parsed.config.sha256,
					receiptSha256: receipt.sha256,
					receipt: receipt.json,
					overrides: body.overrides,
					excludedDispatches: judged.excluded,
					idempotencyKey: key,
					requestSha256: hash,
				};
				const row = await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.gate_run",
					entityType: "mission",
					entityId: m.id,
					missionId: m.id,
					engagementId: m.engagementId,
					requestId: ctx.requestId,
					payload,
				});
				return {
					replayed: false,
					run: toRun({ id: row.id, at: row.at, missionId: m.id }, payload),
				};
			});
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(result.run) };
			}
			return { status: 201, body: ok(result.run) };
		},

		runs: async ({ params, query }) => {
			const db = deps.db();
			await liveMission(db, params.id);
			const rows = await db
				.select({
					...actorColumns,
					at: activityLog.at,
					payload: activityLog.payload,
				})
				.from(activityLog)
				.leftJoin(user, eq(user.id, activityLog.actorUserId))
				.leftJoin(
					rosterEntry,
					eq(rosterEntry.id, activityLog.actorRosterEntryId),
				)
				.leftJoin(
					agentTemplate,
					eq(agentTemplate.id, rosterEntry.agentTemplateId),
				)
				.where(
					and(
						gateRuns(params.id),
						query.cursor ? afterRun(query.cursor) : undefined,
					),
				)
				.orderBy(desc(activityLog.at), desc(activityLog.id))
				.limit(query.limit + 1);
			const [counted] = await db
				.select({ total: count() })
				.from(activityLog)
				.where(gateRuns(params.id));
			const { items, nextCursor } = toPage(
				rows.map((r) => ({ ...r, createdAt: r.at })),
				query.limit,
			);
			return {
				status: 200,
				body: {
					success: true,
					data: items.map((r): GateRunSummary => {
						const p = r.payload as GateRunPayload;
						return {
							id: r.id,
							at: r.at.toISOString(),
							result: resultOfRun(p),
							commitSha: p.commitSha,
							baseSha: p.baseSha,
							receiptSha256: p.receiptSha256,
							configSha256: p.configSha256,
							decideVersion: p.decideVersion,
							receiptVersion: p.receiptVersion,
							actor: activityActor(r),
						};
					}),
					meta: { nextCursor, total: counted?.total ?? 0 },
				},
			};
		},

		getRun: async ({ params }) => {
			const db = deps.db();
			await liveMission(db, params.id);
			const [row] = await db
				.select({
					id: activityLog.id,
					at: activityLog.at,
					missionId: activityLog.missionId,
					payload: activityLog.payload,
				})
				.from(activityLog)
				.where(and(gateRuns(params.id), eq(activityLog.id, params.runId)));
			if (!row) throw notFound("gate run", params.runId);
			return {
				status: 200,
				body: ok(toRun(row, row.payload as GateRunPayload)),
			};
		},
	});
}

/** Parsed JSON, or undefined when the bytes are not JSON. */
function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

/** Gate runs page on (at desc, id desc), the activity feed's own order. */
function afterRun(cursor: string) {
	const { createdAt, id } = decodeCursor(cursor);
	return sql`(${activityLog.at}, ${activityLog.id}) < (${createdAt.toISOString()}::timestamptz, ${id}::uuid)`;
}
