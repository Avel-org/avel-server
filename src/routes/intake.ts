import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
	type Boundary,
	type Brief,
	type ConventionSet,
	type Intake,
	type IntakeStatus,
	intakeContract,
	ok,
	parseGitHubRepoUrl,
} from "../contract";
import { logActivity } from "../db/activity";
import { openCanonQuestions, openCanonSessionIds } from "../db/canon";
import { clientIdOfIntake } from "../db/client-id";
import {
	client,
	connection,
	engagement,
	file,
	intake,
	intakeFiles,
	mission,
} from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import type { RepoSource } from "../gateways/repo-source";
import { briefSourceIssues, inFiles } from "../lib/brief-sources";
import { checkIntake } from "../lib/intake-check";
import { lowConfidenceIssues } from "../lib/repo-read/conventions";
import { readRepo } from "../lib/repo-read/index";
import { ApiError } from "../middleware/errors";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof intake.$inferSelect;

/**
 * Refuses a brief whose sources name no file of the intake: purged files
 * count, since their rows and hashes stay. A new intake has no files yet, so
 * on create every source is refused.
 */
async function requireKnownSources(
	tx: Tx,
	intakeId: string | null,
	brief: Intake["proposedBrief"] | undefined,
) {
	const shas = new Set<string>();
	if (intakeId !== null) {
		const rows = await tx
			.select({ sha256: file.sha256 })
			.from(file)
			.innerJoin(intakeFiles, eq(intakeFiles.fileId, file.id))
			.where(eq(intakeFiles.intakeId, intakeId));
		for (const r of rows) shas.add(r.sha256);
	}
	const issues = briefSourceIssues(brief, inFiles(shas), ["proposedBrief"]);
	if (issues.length > 0) {
		throw new ApiError(
			"VALIDATION_FAILED",
			"The brief cites passages of files this intake does not have",
			{ details: { body: issues } },
		);
	}
}

/**
 * Database row (snake_case columns, Dates) to wire shape (camelCase, ISO
 * strings). openCanonSessionId is derived, never stored: see wireOf.
 */
function toWire(row: Row, openCanonSessionId: string | null): Intake {
	return {
		id: row.id,
		engagementId: row.engagementId,
		status: row.status,
		sourceMd: row.sourceMd,
		proposedBrief: row.proposedBrief as Brief | null,
		openQuestions: row.openQuestions,
		derivedCut: row.derivedCut,
		derivedCutEvidence: row.derivedCutEvidence,
		derivedConventions: row.derivedConventions as ConventionSet | null,
		derivedBoundaries: row.derivedBoundaries as Boundary[] | null,
		repoUrl: row.repoUrl,
		repoCommitSha: row.repoCommitSha,
		repoReadAt: row.repoReadAt?.toISOString() ?? null,
		suggestedPresetId: row.suggestedPresetId,
		approvedBy: row.approvedBy,
		approvedAt: row.approvedAt?.toISOString() ?? null,
		missionId: row.missionId,
		draftedByCanonSessionId: row.draftedByCanonSessionId,
		openCanonSessionId,
		recommendedRoster: row.recommendedRoster ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** One intake's wire, with its open Canon session read under its client's scope. */
async function wireOf(db: Executor, row: Row): Promise<Intake> {
	const open = await openCanonSessionIds(db, [row.id]);
	return toWire(row, open.get(row.id) ?? null);
}

/**
 * An intake is visible while it, its engagement and its client are live, as
 * a client mission is. Inner joins, so a removed parent hides it.
 */
function visible(db: Executor) {
	return db
		.select(getTableColumns(intake))
		.from(intake)
		.innerJoin(
			engagement,
			and(eq(engagement.id, intake.engagementId), live(engagement)),
		)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.$dynamic();
}

/**
 * The intake, locked for the rest of the transaction. Every transition reads
 * through here, so two writers on one intake run one after the other and the
 * second sees the first's status. Propose and approve check the content they
 * locked, so a concurrent revise cannot slip an unchecked brief past them.
 */
async function lockIntake(tx: Tx, id: string): Promise<Row> {
	const [row] = await visible(tx)
		.where(and(eq(intake.id, id), live(intake)))
		.for("update", { of: intake });
	if (!row) throw notFound("intake", id);
	return row;
}

function wrongState(row: Row, action: string): ApiError {
	return new ApiError("CONFLICT", `A ${row.status} intake cannot be ${action}`);
}

/**
 * The engagement, locked for share so it cannot be closed or removed between
 * this check and the write that depends on it.
 */
async function requireActiveEngagement(tx: Tx, engagementId: string) {
	const [parent] = await tx
		.select({ status: engagement.status })
		.from(engagement)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(engagement.id, engagementId), live(engagement)))
		.for("share", { of: engagement });
	if (!parent) {
		throw new ApiError("PRECONDITION_FAILED", "The engagement does not exist", {
			details: { reason: "engagement_not_found", engagementId },
		});
	}
	if (parent.status !== "active") {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"A closed engagement cannot take this intake",
			{ details: { reason: "engagement_closed", engagementId } },
		);
	}
}

function checkFailed(issues: ReturnType<typeof checkIntake>): ApiError {
	return new ApiError(
		"PRECONDITION_FAILED",
		"The intake does not pass the mechanical check",
		{ details: { reason: "intake_check_failed", issues } },
	);
}

type ConnectionRow = typeof connection.$inferSelect;

function connectionRefused(
	reason:
		| "connection_not_found"
		| "connection_expired"
		| "connection_scope_mismatch"
		| "connection_credential_missing",
	message: string,
	connectionId: string,
): ApiError {
	return new ApiError("PRECONDITION_FAILED", message, {
		details: { reason, connectionId },
	});
}

/**
 * Whether a connection may read this repository now: live, of the intake's
 * engagement, active and unexpired, scoped to cover the repository. The
 * credential is checked separately, by name, through the gateway.
 */
function usableConnection(
	row: ConnectionRow | undefined,
	connectionId: string,
	engagementId: string,
	repo: { owner: string; repo: string },
	now: Date,
): ConnectionRow {
	if (!row || row.engagementId !== engagementId) {
		throw connectionRefused(
			"connection_not_found",
			"The intake's engagement has no such connection",
			connectionId,
		);
	}
	if (row.status === "revoked") {
		throw new ApiError("CONNECTION_REVOKED", "The connection is revoked", {
			details: { connectionId },
		});
	}
	if (row.status === "expired" || (row.expiresAt && row.expiresAt <= now)) {
		throw connectionRefused(
			"connection_expired",
			"The connection has expired",
			connectionId,
		);
	}
	const scope = row.scopeValue.toLowerCase();
	const covers =
		row.scopeType === "owner"
			? scope === repo.owner
			: scope === `${repo.owner}/${repo.repo}`;
	if (!covers) {
		throw connectionRefused(
			"connection_scope_mismatch",
			`The connection is scoped to ${row.scopeValue}, which does not cover ${repo.owner}/${repo.repo}`,
			connectionId,
		);
	}
	return row;
}

export function intakeRoutes(deps: RouteDeps & { repos: RepoSource }) {
	/** Applies `set` to a locked intake and logs `action`, in the caller's transaction. */
	async function transition(
		tx: Tx,
		ctx: RequestContext,
		row: Row,
		set: Partial<typeof intake.$inferInsert>,
		action:
			| "intake.updated"
			| "intake.proposed"
			| "intake.approved"
			| "intake.rejected"
			| "intake.repo_read",
		payload: Record<string, unknown>,
	): Promise<Row> {
		const operator = operatorOf(ctx);
		const [updated] = await tx
			.update(intake)
			.set({ ...set, ...touch(deps.clock) })
			.where(and(eq(intake.id, row.id), eq(intake.status, row.status)))
			.returning();
		// lockIntake holds the row, so its status cannot have moved.
		if (!updated) throw new Error(`intake ${row.id} changed while locked`);
		await logActivity(tx, deps, {
			actorKind: "operator",
			actorUserId: operator.id,
			action,
			entityType: "intake",
			entityId: row.id,
			missionId: updated.missionId,
			engagementId: row.engagementId,
			requestId: ctx.requestId,
			payload,
		});
		return updated;
	}

	return tsr.platformContext<RequestContext>().router(intakeContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = and(
				live(intake),
				query.engagementId
					? eq(intake.engagementId, query.engagementId)
					: undefined,
				query.status
					? inArray(intake.status, query.status as IntakeStatus[])
					: undefined,
			);
			// The page and the total in one round. The total uses the filters
			// without the cursor, so it is the same on every page.
			const [rows, [counted]] = await Promise.all([
				visible(db)
					.where(and(filters, after(intake, query.cursor)))
					.orderBy(desc(intake.createdAt), desc(intake.id))
					.limit(query.limit + 1),
				db
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(intake)
					.innerJoin(
						engagement,
						and(eq(engagement.id, intake.engagementId), live(engagement)),
					)
					.innerJoin(
						client,
						and(eq(client.id, engagement.clientId), live(client)),
					)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			const open = await openCanonSessionIds(
				db,
				items.map((r) => r.id),
			);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map((r) => toWire(r, open.get(r.id) ?? null)),
					meta: { nextCursor, total: counted?.n ?? 0 },
				},
			};
		},

		get: async ({ params }) => {
			const [row] = await visible(deps.db()).where(
				and(eq(intake.id, params.id), live(intake)),
			);
			if (!row) throw notFound("intake", params.id);
			return { status: 200, body: ok(await wireOf(deps.db(), row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				await requireActiveEngagement(tx, body.engagementId);
				await requireKnownSources(tx, null, body.proposedBrief);
				const values = {
					id: deps.ids.next(),
					engagementId: body.engagementId,
					status: "draft" as const,
					sourceMd: body.sourceMd,
					proposedBrief: body.proposedBrief ?? null,
					openQuestions: body.openQuestions ?? [],
					...stamp(deps.clock),
				};
				const [inserted] = await tx.insert(intake).values(values).returning();
				if (!inserted) throw new Error("intake insert returned no row");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "intake.created",
					entityType: "intake",
					entityId: values.id,
					engagementId: values.engagementId,
					requestId: ctx.requestId,
					payload: {},
				});
				return inserted;
			});
			return { status: 201, body: ok(await wireOf(deps.db(), row)) };
		},

		revise: async ({ params, body }, ctx) => {
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft" && current.status !== "proposed") {
					throw wrongState(current, "revised");
				}
				await requireKnownSources(tx, current.id, body.proposedBrief);
				// The source can run to 100k characters, so the log names the
				// fields that changed rather than copying them.
				return transition(
					tx,
					ctx,
					current,
					{ ...body, status: "draft" },
					"intake.updated",
					{
						fields: Object.keys(body).sort(),
						from: current.status,
					},
				);
			});
			return { status: 200, body: ok(await wireOf(deps.db(), row)) };
		},

		propose: async ({ params }, ctx) => {
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft") throw wrongState(current, "proposed");
				const issues = checkIntake(current);
				if (issues.length > 0) throw checkFailed(issues);
				return transition(
					tx,
					ctx,
					current,
					{ status: "proposed" },
					"intake.proposed",
					{},
				);
			});
			return { status: 200, body: ok(await wireOf(deps.db(), row)) };
		},

		approve: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "proposed")
					throw wrongState(current, "approved");
				await requireActiveEngagement(tx, current.engagementId);
				const issues = checkIntake({
					...current,
					acknowledged: body.acknowledged,
				});
				if (issues.length > 0) throw checkFailed(issues);
				// Canon asks before it guesses. An open question means the brief
				// still rests on a guess, so approval waits. The helper sets the
				// client scope itself: unscoped, row-level security would hide
				// every question and read as "none open".
				const clientId = await clientIdOfIntake(tx, current.id);
				if (clientId === null)
					throw new Error(`intake ${current.id} has no client`);
				const open = await openCanonQuestions(tx, clientId, current.id);
				if (open.length > 0) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"Canon still has open questions on this intake",
						{
							details: {
								reason: "intake_questions_open",
								engagementId: current.engagementId,
								issues: open.map((q) => ({
									path: ["canonQuestions", q.id],
									message: q.header,
								})),
							},
						},
					);
				}
				// The cut is derived from the repository (module 2), never chosen
				// here, so an intake whose repository has not been read waits.
				if (current.derivedCut === null) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The repository has not been read, so there is no derived cut",
						{
							details: {
								reason: "intake_cut_not_derived",
								engagementId: current.engagementId,
							},
						},
					);
				}
				// The mission is built on the repository that was read, never on
				// one named only at approval.
				const named = parseGitHubRepoUrl(body.repoUrl)?.url;
				if (current.repoUrl === null || named !== current.repoUrl) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						current.repoUrl === null
							? "No repository has been read for this intake"
							: `The intake's cut was read from ${current.repoUrl}, not ${body.repoUrl}`,
						{
							details: {
								reason: "intake_repo_mismatch",
								engagementId: current.engagementId,
							},
						},
					);
				}
				const conventions = current.derivedConventions as ConventionSet | null;
				const low = conventions ? lowConfidenceIssues(conventions) : [];
				if (low.length > 0) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"The repository's conventions disagree with themselves; fix the repository and read it again",
						{
							details: {
								reason: "intake_conventions_low_confidence",
								engagementId: current.engagementId,
								issues: low,
							},
						},
					);
				}
				const now = deps.clock.now();
				const missionId = deps.ids.next();
				await tx.insert(mission).values({
					id: missionId,
					engagementId: current.engagementId,
					origin: "client",
					type: body.missionType,
					brief: current.proposedBrief as Brief,
					sprintN: 1,
					status: "draft",
					cut: current.derivedCut,
					cutSource: "derived",
					cutRationale: null,
					repoUrl: current.repoUrl,
					spendCeilingUsd: body.spendCeilingUsd?.toFixed(2) ?? null,
					deletedAt: null,
					...stamp(deps.clock),
				});
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "mission.created",
					entityType: "mission",
					entityId: missionId,
					missionId,
					engagementId: current.engagementId,
					requestId: ctx.requestId,
					payload: {
						intakeId: current.id,
						type: body.missionType,
						spendCeilingUsd: body.spendCeilingUsd ?? null,
					},
				});
				return transition(
					tx,
					ctx,
					current,
					{
						status: "approved",
						approvedBy: operator.id,
						approvedAt: now,
						missionId,
					},
					"intake.approved",
					{ missionId, acknowledged: body.acknowledged },
				);
			});
			return { status: 200, body: ok(await wireOf(deps.db(), row)) };
		},

		readRepo: async ({ params, body }, ctx) => {
			const db = deps.db();
			// Checked before GitHub is called, so a wrong state or a bad
			// connection costs no request. Checked again under the lock below.
			const [found] = await visible(db).where(
				and(eq(intake.id, params.id), live(intake)),
			);
			if (!found) throw notFound("intake", params.id);
			if (found.status !== "draft" && found.status !== "proposed") {
				throw wrongState(found, "read");
			}
			const repo = parseGitHubRepoUrl(body.repoUrl);
			if (!repo) throw new Error("the contract admitted a non-GitHub URL");
			const loadConnection = async (ex: Executor) => {
				const [row] = await ex
					.select()
					.from(connection)
					.where(and(eq(connection.id, body.connectionId), live(connection)));
				return row;
			};
			const conn = usableConnection(
				await loadConnection(db),
				body.connectionId,
				found.engagementId,
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

			// One read of one commit; pure from here on.
			const snapshot = await deps.repos.snapshot({
				owner: repo.owner,
				repo: repo.repo,
				ref: body.ref,
				credentialRef: conn.credentialRef,
			});
			const read = readRepo(snapshot);

			const row = await withTx(db, async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft" && current.status !== "proposed") {
					throw wrongState(current, "read");
				}
				// The connection may have been revoked while GitHub answered.
				usableConnection(
					await loadConnection(tx),
					body.connectionId,
					current.engagementId,
					repo,
					deps.clock.now(),
				);
				return transition(
					tx,
					ctx,
					current,
					{
						derivedCut: read.cut,
						derivedCutEvidence: read.cutEvidence,
						derivedConventions: read.conventions,
						derivedBoundaries: read.boundaries,
						repoUrl: repo.url,
						repoCommitSha: read.commitSha,
						repoReadAt: deps.clock.now(),
					},
					"intake.repo_read",
					{
						connectionId: conn.id,
						repoUrl: repo.url,
						ref: body.ref ?? null,
						commitSha: read.commitSha,
						cut: read.cut,
						confidence: read.conventions.confidence,
					},
				);
			});
			return { status: 200, body: ok(await wireOf(deps.db(), row)) };
		},

		reject: async ({ params, body }, ctx) => {
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockIntake(tx, params.id);
				if (current.status !== "draft" && current.status !== "proposed") {
					throw wrongState(current, "rejected");
				}
				return transition(
					tx,
					ctx,
					current,
					{ status: "rejected" },
					"intake.rejected",
					{ reason: body.reason },
				);
			});
			return { status: 200, body: ok(await wireOf(deps.db(), row)) };
		},
	});
}
