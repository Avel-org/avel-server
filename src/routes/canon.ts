import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	max,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	type CanonCitation,
	type CanonMessage,
	type CanonMode,
	type CanonQuestion,
	type CanonSession,
	type CanonSessionListItem,
	type ClientMemory,
	canonContract,
	ok,
	type PreconditionReason,
	page,
	type RunStep,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	type ClientId,
	canonSessionScope,
	clientIdOfCanonQuestion,
	clientIdOfClient,
	clientIdOfClientMemory,
	clientIdOfIntake,
} from "../db/client-id";
import { currentIdentity } from "../db/identity";
import {
	agentTemplate,
	canonMessage,
	canonQuestion,
	canonSession,
	canonStep,
	client,
	clientMemory,
	engagement,
	file,
	intake,
	intakeFiles,
	user,
} from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import {
	type CanonScope,
	type Executor,
	type Tx,
	withCanonScope,
	withClientScope,
	withOpenScope,
	withTx,
} from "../db/tx";
import { checkCanonAnswer } from "../lib/canon-answer";
import { requestSha256 } from "../lib/canonical";
import { priceFor } from "../lib/prices";
import { ApiError } from "../middleware/errors";
import { type PriceBook, tableFor } from "../runner/budget";
import type { Harness } from "../runner/harness";
import { activityActor } from "./activity";
import {
	after,
	asDate,
	containsPattern,
	decodeCursor,
	encodeCursor,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

/**
 * Canon's routes (src/contract/canon.ts). Canon drafts; the operator decides.
 *
 * Every route runs under one client's scope (withClientScope). Routes keyed
 * by an intake or a client find it from those rows; routes keyed by a Canon
 * id find it through the one-fact SECURITY DEFINER lookups in
 * src/db/client-id.ts, then read the row under that scope, so the policy
 * still guards it. An id the scope cannot see is 404.
 *
 * Activity payloads hold ids, hashes, statuses and counts only: never
 * content, question or answer text. activity_log is not under row-level
 * security (a standing rule, BE Main 2026-10-19).
 */

type CanonDeps = RouteDeps & {
	harness: Pick<Harness, "model" | "version">;
	prices: PriceBook;
};

const REPLAYED = "Idempotency-Replayed";
/** A session's default estimate, when the operator gives none. A [hypothesis]. */
export const CANON_DEFAULT_ESTIMATE = 60_000;
/** The template whose current identity a session freezes. */
export const CANON_TEMPLATE_SLUG = "canon";

function refuse(reason: PreconditionReason, message: string): ApiError {
	return new ApiError("PRECONDITION_FAILED", message, {
		details: { reason },
	});
}

/** The live intake (engagement and client live too), its client, or 404. */
async function intakeScope(db: Executor, intakeId: string) {
	const [row] = await db
		.select({ status: intake.status, engagementId: intake.engagementId })
		.from(intake)
		.innerJoin(
			engagement,
			and(eq(engagement.id, intake.engagementId), live(engagement)),
		)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(intake.id, intakeId), live(intake)));
	const clientId = row ? await clientIdOfIntake(db, intakeId) : null;
	if (!row || !clientId) throw notFound("intake", intakeId);
	return { clientId, engagementId: row.engagementId };
}

/** The live client, as a scope, or 404. */
async function clientScope(db: Executor, clientId: string): Promise<ClientId> {
	const [row] = await db
		.select({ id: client.id })
		.from(client)
		.where(and(eq(client.id, clientId), live(client)));
	const scope = row ? await clientIdOfClient(db, clientId) : null;
	if (!scope) throw notFound("client", clientId);
	return scope;
}

/** The session's scope (a client's, or open), or 404. */
async function sessionScopeOr404(
	db: Executor,
	id: string,
): Promise<CanonScope> {
	const scope = await canonSessionScope(db, id);
	if (!scope) throw notFound("canon session", id);
	return scope;
}

async function scopeOr404(
	lookup: Promise<ClientId | null>,
	entity: string,
	id: string,
): Promise<ClientId> {
	const scope = await lookup;
	if (!scope) throw notFound(entity, id);
	return scope;
}

/** The keyset after a cursor, ascending: (created_at asc, id asc). */
function afterAscending(
	table: {
		createdAt: typeof canonQuestion.createdAt;
		id: typeof canonQuestion.id;
	},
	cursor: string | undefined,
): SQL | undefined {
	if (!cursor) return undefined;
	const at = decodeCursor(cursor);
	return or(
		gt(table.createdAt, at.createdAt),
		and(eq(table.createdAt, at.createdAt), gt(table.id, at.id)),
	);
}

const operatorActor = (rowId: string, userId: string, login: string | null) =>
	activityActor({
		id: rowId,
		actorKind: "operator",
		actorUserId: userId,
		actorRosterEntryId: null,
		actorCanonSessionId: null,
		login,
		agentTemplateId: null,
		agentSlug: null,
		agentName: null,
		territory: null,
	});

const canonActor = (rowId: string, sessionId: string) =>
	activityActor({
		id: rowId,
		actorKind: "canon",
		actorUserId: null,
		actorRosterEntryId: null,
		actorCanonSessionId: sessionId,
		login: null,
		agentTemplateId: null,
		agentSlug: null,
		agentName: null,
		territory: null,
	});

async function loginsOf(tx: Tx, userIds: readonly (string | null)[]) {
	const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
	if (ids.length === 0) return new Map<string, string>();
	const rows = await tx
		.select({ id: user.id, login: user.githubLogin })
		.from(user)
		.where(inArray(user.id, ids));
	return new Map(rows.map((r) => [r.id, r.login]));
}

type ResolvedFile = { fileId: string; fileName: string; purged: boolean };

/**
 * Each chunk's file, by the chunk's sha256, among the intake's files. Where
 * two files share the bytes, a live one wins over a purged one, then the
 * oldest. A hash none of them has is a broken invariant (the harness checks
 * chunk ids at write, and nothing unlinks an intake's files): a 500, never
 * a made-up file.
 */
async function resolveChunks(
	tx: Tx,
	intakeId: string | null,
	chunkIds: readonly string[],
): Promise<Map<string, ResolvedFile>> {
	const shas = [...new Set(chunkIds.map((c) => c.split(":")[0] ?? ""))];
	const resolved = new Map<string, ResolvedFile>();
	if (shas.length === 0) return resolved;
	// A session with no intake has no files, so the turn gave it no passages.
	if (intakeId === null) {
		throw new Error("a session with no intake cites a chunk");
	}
	const rows = await tx
		.select({
			id: file.id,
			name: file.name,
			sha256: file.sha256,
			purgedAt: file.purgedAt,
		})
		.from(file)
		.innerJoin(intakeFiles, eq(intakeFiles.fileId, file.id))
		.where(and(eq(intakeFiles.intakeId, intakeId), inArray(file.sha256, shas)))
		.orderBy(
			sql`${file.purgedAt} is not null`,
			asc(file.createdAt),
			asc(file.id),
		);
	for (const r of rows) {
		if (!resolved.has(r.sha256)) {
			resolved.set(r.sha256, {
				fileId: r.id,
				fileName: r.name,
				purged: r.purgedAt !== null,
			});
		}
	}
	for (const sha of shas) {
		if (!resolved.has(sha)) {
			throw new Error(
				`intake ${intakeId}: a chunk cites ${sha}, which none of its files has`,
			);
		}
	}
	return resolved;
}

function fileOf(resolved: Map<string, ResolvedFile>, chunkId: string) {
	const found = resolved.get(chunkId.split(":")[0] ?? "");
	if (!found) throw new Error(`chunk ${chunkId} did not resolve`);
	return found;
}

type SessionRow = typeof canonSession.$inferSelect;

/** The wire's halt reason. A CHECK refuses spend_ceiling, so reading one is a broken row. */
function wireHaltReason(r: SessionRow): CanonSession["haltReason"] {
	if (r.haltReason === "spend_ceiling") {
		throw new Error(`canon_session ${r.id}: halted at a spend ceiling`);
	}
	return r.haltReason;
}

/** Sessions to the wire: their last seq, open questions and opener read alongside. */
async function sessionWires(
	tx: Tx,
	rows: readonly SessionRow[],
): Promise<CanonSession[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const seqs = await tx
		.select({ id: canonMessage.canonSessionId, last: max(canonMessage.seq) })
		.from(canonMessage)
		.where(inArray(canonMessage.canonSessionId, ids))
		.groupBy(canonMessage.canonSessionId);
	const open = await tx
		.select({
			id: canonQuestion.canonSessionId,
			n: sql<number>`count(*)`.mapWith(Number),
		})
		.from(canonQuestion)
		.where(
			and(
				inArray(canonQuestion.canonSessionId, ids),
				eq(canonQuestion.status, "open"),
			),
		)
		.groupBy(canonQuestion.canonSessionId);
	const lastSeq = new Map(seqs.map((s) => [s.id, s.last ?? 0]));
	const openCount = new Map(open.map((o) => [o.id, o.n]));
	const logins = await loginsOf(
		tx,
		rows.map((r) => r.openedBy),
	);
	return rows.map((r) => ({
		id: r.id,
		scope: r.scope,
		clientId: r.clientId,
		engagementId: r.engagementId,
		intakeId: r.intakeId,
		title: r.title,
		titleSetBy: r.titleSetBy,
		mode: r.mode,
		status: r.status,
		haltReason: wireHaltReason(r),
		model: r.model,
		estimatedTokens: r.estimatedTokens,
		tokenSoftCeiling: r.tokenSoftCeiling,
		tokenHardCeiling: r.tokenHardCeiling,
		tokensUsed: r.tokensUsed,
		spendUsd: Number(r.spendUsd),
		turn: r.turnStartedAt === null ? "idle" : "canon",
		lastSeq: lastSeq.get(r.id) ?? 0,
		openQuestions: openCount.get(r.id) ?? 0,
		openedBy: operatorActor(r.id, r.openedBy, logins.get(r.openedBy) ?? null),
		openedAt: r.openedAt.toISOString(),
		closedAt: r.closedAt?.toISOString() ?? null,
		archivedAt: r.archivedAt?.toISOString() ?? null,
		lastActivityAt: r.lastActivityAt.toISOString(),
	}));
}

async function oneSessionWire(tx: Tx, row: SessionRow) {
	const [wire] = await sessionWires(tx, [row]);
	if (!wire) throw new Error(`canon_session ${row.id}: no wire`);
	return wire;
}

type MessageRow = typeof canonMessage.$inferSelect;

async function messageWires(
	tx: Tx,
	intakeId: string | null,
	rows: readonly MessageRow[],
): Promise<CanonMessage[]> {
	const resolved = await resolveChunks(
		tx,
		intakeId,
		rows.flatMap((r) => r.citations.map((c) => c.chunkId)),
	);
	return rows.map((r) => ({
		id: r.id,
		seq: r.seq,
		role: r.role,
		mode: r.mode,
		contentMd: r.contentMd,
		citations: r.citations.map(
			(c): CanonCitation => ({
				...fileOf(resolved, c.chunkId),
				chunkId: c.chunkId,
				heading: c.heading,
				quote: c.quote,
			}),
		),
		parts: r.parts,
		createdAt: r.createdAt.toISOString(),
	}));
}

/** One row of canon_session_index(), as postgres-js returns it. */
type IndexRow = {
	id: string;
	scope: CanonSession["scope"];
	client_id: string | null;
	engagement_id: string | null;
	intake_id: string | null;
	title: string | null;
	mode: CanonMode;
	status: CanonSession["status"];
	halt_reason: SessionRow["haltReason"];
	archived_at: Date | string | null;
	last_activity_at: Date | string;
	opened_at: Date | string;
	turn_started_at: Date | string | null;
};

function listItemOf(r: IndexRow): CanonSessionListItem {
	if (r.halt_reason === "spend_ceiling") {
		throw new Error(`canon_session ${r.id}: halted at a spend ceiling`);
	}
	return {
		id: r.id,
		scope: r.scope,
		clientId: r.client_id,
		engagementId: r.engagement_id,
		intakeId: r.intake_id,
		title: r.title,
		mode: r.mode,
		status: r.status,
		haltReason: r.halt_reason,
		turn: r.turn_started_at === null ? "idle" : "canon",
		openedAt: asDate(r.opened_at).toISOString(),
		archivedAt:
			r.archived_at === null ? null : asDate(r.archived_at).toISOString(),
		lastActivityAt: asDate(r.last_activity_at).toISOString(),
	};
}

type StepRow = typeof canonStep.$inferSelect;

function stepWire(r: StepRow): RunStep {
	return {
		id: r.id,
		seq: r.seq,
		turn: r.turn,
		kind: r.kind,
		label: r.label,
		detail: r.detail,
		startedAt: r.startedAt.toISOString(),
		endedAt: r.endedAt?.toISOString() ?? null,
		tokensIn: r.tokensIn,
		tokensOut: r.tokensOut,
	};
}

type QuestionRow = typeof canonQuestion.$inferSelect;

async function questionWires(
	tx: Tx,
	rows: readonly QuestionRow[],
): Promise<CanonQuestion[]> {
	const logins = await loginsOf(
		tx,
		rows.map((r) => r.decidedBy),
	);
	const out: CanonQuestion[] = [];
	for (const r of rows) {
		const resolved = await resolveChunks(tx, r.intakeId, r.sourceChunkIds);
		out.push({
			id: r.id,
			intakeId: r.intakeId,
			canonSessionId: r.canonSessionId,
			header: r.header,
			question: r.question,
			options: r.options,
			multiSelect: r.multiSelect,
			reason: r.reason,
			sources: r.sourceChunkIds.map((chunkId) => ({
				...fileOf(resolved, chunkId),
				chunkId,
			})),
			status: r.status,
			answer: r.answer
				? { selected: r.answer.selected, other: r.answer.other ?? null }
				: null,
			effectMd: r.effectMd,
			decidedBy: r.decidedBy
				? operatorActor(r.id, r.decidedBy, logins.get(r.decidedBy) ?? null)
				: null,
			decidedAt: r.decidedAt?.toISOString() ?? null,
			createdAt: r.createdAt.toISOString(),
		});
	}
	return out;
}

type MemoryRow = typeof clientMemory.$inferSelect;

async function memoryWires(
	tx: Tx,
	rows: readonly MemoryRow[],
): Promise<ClientMemory[]> {
	const logins = await loginsOf(
		tx,
		rows.map((r) => r.decidedBy),
	);
	return rows.map((r) => ({
		id: r.id,
		clientId: r.clientId,
		contentMd: r.contentMd,
		status: r.status,
		proposedBy: r.proposedByCanonSessionId
			? canonActor(r.id, r.proposedByCanonSessionId)
			: null,
		decidedBy: r.decidedBy
			? operatorActor(r.id, r.decidedBy, logins.get(r.decidedBy) ?? null)
			: null,
		decidedAt: r.decidedAt?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}));
}

async function oneOf<T>(wires: Promise<T[]>): Promise<T> {
	const [wire] = await wires;
	if (!wire) throw new Error("expected one wire");
	return wire;
}

/** The row under the scope, locked, or 404: what the lookup said must hold here too. */
async function lockedSession(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(canonSession)
		.where(eq(canonSession.id, id))
		.for("update");
	if (!row) throw notFound("canon session", id);
	return row;
}

async function lockedQuestion(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(canonQuestion)
		.where(eq(canonQuestion.id, id))
		.for("update");
	if (!row) throw notFound("canon question", id);
	return row;
}

async function lockedMemory(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(clientMemory)
		.where(eq(clientMemory.id, id))
		.for("update");
	if (!row) throw notFound("client memory", id);
	return row;
}

export function canonRoutes(deps: CanonDeps) {
	const sha = (text: string) => requestSha256({ contentMd: text });

	/** The estimate and ceilings: omitted ones follow the estimate, as on a dispatch. */
	const ceilingsOf = (body: {
		estimatedTokens?: number;
		tokenSoftCeiling?: number;
		tokenHardCeiling?: number;
	}) => {
		const estimate = body.estimatedTokens ?? CANON_DEFAULT_ESTIMATE;
		const soft = body.tokenSoftCeiling ?? Math.ceil(estimate * 1.5);
		const hard = body.tokenHardCeiling ?? Math.max(estimate * 3, soft);
		if (soft < estimate || hard < soft) {
			throw new ApiError(
				"VALIDATION_FAILED",
				"The ceilings do not fit the estimate",
				{
					details: {
						body: [
							{
								path: [
									soft < estimate ? "tokenSoftCeiling" : "tokenHardCeiling",
								],
								message:
									soft < estimate
										? "The soft ceiling must be at least the estimate"
										: "The hard ceiling must be at least the soft ceiling",
							},
						],
					},
				},
			);
		}
		return { estimate, soft, hard };
	};

	/**
	 * Inserts an open session in the transaction's scope, with Canon's
	 * current identity and the model's price frozen, and logs it. The caller
	 * checks the intake; the database holds one open session per intake.
	 */
	const insertSession = async (
		s: Tx,
		ctx: RequestContext,
		o: {
			place: {
				scope: "open" | "client";
				clientId: ClientId | null;
				engagementId: string | null;
				intakeId: string | null;
			};
			mode: CanonMode;
			limits: { estimate: number; soft: number; hard: number };
			idempotency: { key: string; hash: string } | null;
		},
	) => {
		const operator = operatorOf(ctx);
		if (o.place.intakeId) {
			const [openOne] = await s
				.select({ id: canonSession.id })
				.from(canonSession)
				.where(
					and(
						eq(canonSession.intakeId, o.place.intakeId),
						eq(canonSession.status, "open"),
					),
				);
			if (openOne) {
				throw refuse(
					"canon_session_open",
					"This intake already has an open Canon session",
				);
			}
		}
		const [template] = await s
			.select({ id: agentTemplate.id })
			.from(agentTemplate)
			.where(
				and(eq(agentTemplate.slug, CANON_TEMPLATE_SLUG), live(agentTemplate)),
			);
		const identity = template ? await currentIdentity(s, template.id) : null;
		if (!identity) {
			throw refuse(
				"agent_identity_missing",
				"Canon has no identity to open a session with",
			);
		}
		const model = deps.harness.model;
		const table = tableFor(deps.prices, deps.prices.current);
		if (!table || !priceFor(model, table)) {
			throw new ApiError("PRECONDITION_FAILED", `No price for ${model}`, {
				details: { reason: "model_price_unknown", model },
			});
		}
		const now = deps.clock.now();
		const [row] = await s
			.insert(canonSession)
			.values({
				id: deps.ids.next(),
				...o.place,
				status: "open",
				mode: o.mode,
				title: null,
				titleSetBy: null,
				archivedAt: null,
				lastActivityAt: now,
				haltReason: null,
				agentIdentityVersionId: identity.id,
				model,
				priceVersion: deps.prices.current,
				harnessVersion: deps.harness.version,
				estimatedTokens: o.limits.estimate,
				tokenSoftCeiling: o.limits.soft,
				tokenHardCeiling: o.limits.hard,
				tokensUsed: 0,
				tokensIn: 0,
				tokensOut: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				spendUsd: "0",
				openedBy: operator.id,
				openedAt: now,
				closedAt: null,
				turnStartedAt: null,
				idempotencyKey: o.idempotency?.key ?? null,
				requestSha256: o.idempotency?.hash ?? null,
				...stamp(deps.clock),
			})
			.returning();
		if (!row) throw new Error("canon_session insert returned no row");
		await logActivity(s, deps, {
			actorKind: "operator",
			actorUserId: operator.id,
			action: "canon_session.opened",
			entityType: "canon_session",
			entityId: row.id,
			engagementId: o.place.engagementId,
			clientId: o.place.clientId,
			requestId: ctx.requestId,
			payload: {
				sessionId: row.id,
				scope: o.place.scope,
				intakeId: o.place.intakeId,
				mode: o.mode,
				estimatedTokens: o.limits.estimate,
				tokenSoftCeiling: o.limits.soft,
				tokenHardCeiling: o.limits.hard,
			},
		});
		return row;
	};

	/** Answer, acknowledge or dismiss: open questions only, decided once. */
	const decide = async (
		ctx: RequestContext,
		id: string,
		status: "answered" | "acknowledged" | "dismissed",
		values: {
			answer?: { selected: string[]; other?: string };
			effectMd?: string;
		},
	) => {
		const operator = operatorOf(ctx);
		const db = deps.db();
		const scope = await scopeOr404(
			clientIdOfCanonQuestion(db, id),
			"canon question",
			id,
		);
		return withTx(db, (tx) =>
			withClientScope(tx, scope, async (s) => {
				const row = await lockedQuestion(s, id);
				if (row.status !== "open") {
					throw refuse("canon_question_not_open", "This question is not open");
				}
				if (values.answer) {
					const issues = checkCanonAnswer(row, values.answer);
					if (issues.length > 0) {
						throw new ApiError(
							"VALIDATION_FAILED",
							"The answer does not fit the question",
							{
								details: {
									body: issues.map((i) => ({
										path: i.path.slice(1),
										message: i.message,
									})),
								},
							},
						);
					}
				}
				const now = deps.clock.now();
				const [updated] = await s
					.update(canonQuestion)
					.set({
						status,
						answer: values.answer ?? null,
						effectMd: values.effectMd ?? null,
						decidedBy: operator.id,
						decidedAt: now,
						updatedAt: now,
					})
					.where(eq(canonQuestion.id, id))
					.returning();
				if (!updated) throw new Error(`canon_question ${id}: no row updated`);
				const [eng] = await s
					.select({ id: intake.engagementId })
					.from(intake)
					.where(eq(intake.id, row.intakeId));
				await logActivity(s, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: `canon_question.${status}`,
					entityType: "canon_question",
					entityId: id,
					engagementId: eng?.id ?? null,
					clientId: row.clientId,
					requestId: ctx.requestId,
					payload: {
						questionId: id,
						intakeId: row.intakeId,
						status,
						selectedCount: values.answer?.selected.length ?? 0,
						hasOther: values.answer?.other !== undefined,
						hasEffect: values.effectMd !== undefined,
					},
				});
				return oneOf(questionWires(s, [updated]));
			}),
		);
	};

	/** Keep, remove or edit a memory: one locked row, one log row. */
	const changeMemory = async (
		ctx: RequestContext,
		id: string,
		change: (row: MemoryRow) => {
			set: Partial<typeof clientMemory.$inferInsert>;
			action:
				| "client_memory.kept"
				| "client_memory.removed"
				| "client_memory.edited";
			payload: Record<string, unknown>;
		} | null,
	) => {
		const operator = operatorOf(ctx);
		const db = deps.db();
		const scope = await scopeOr404(
			clientIdOfClientMemory(db, id),
			"client memory",
			id,
		);
		return withTx(db, (tx) =>
			withClientScope(tx, scope, async (s) => {
				const row = await lockedMemory(s, id);
				const decided = change(row);
				if (!decided) return oneOf(memoryWires(s, [row]));
				const [updated] = await s
					.update(clientMemory)
					.set({ ...decided.set, updatedAt: deps.clock.now() })
					.where(eq(clientMemory.id, id))
					.returning();
				if (!updated) throw new Error(`client_memory ${id}: no row updated`);
				await logActivity(s, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: decided.action,
					entityType: "client_memory",
					entityId: id,
					requestId: ctx.requestId,
					clientId: scope,
					payload: { memoryId: id, ...decided.payload },
				});
				return oneOf(memoryWires(s, [updated]));
			}),
		);
	};

	return tsr.platformContext<RequestContext>().router(canonContract, {
		openSession: async ({ params, headers, body }, ctx) => {
			operatorOf(ctx);
			const db = deps.db();
			const { clientId, engagementId } = await intakeScope(db, params.id);
			const key = headers["idempotency-key"];
			const hash = requestSha256(body);
			const limits = ceilingsOf(body);
			const result = await withTx(db, (tx) =>
				withClientScope(tx, clientId, async (s) => {
					// One writer per intake: an open and a replay of it run in turn.
					const [locked] = await s
						.select({ status: intake.status })
						.from(intake)
						.where(eq(intake.id, params.id))
						.for("update");
					if (!locked) throw notFound("intake", params.id);
					if (key) {
						const [prior] = await s
							.select()
							.from(canonSession)
							.where(
								and(
									eq(canonSession.intakeId, params.id),
									eq(canonSession.idempotencyKey, key),
								),
							);
						if (prior) {
							if (prior.requestSha256 !== hash) {
								throw new ApiError(
									"IDEMPOTENCY_REPLAY",
									"This Idempotency-Key was used with a different body",
								);
							}
							return { replayed: true, wire: await oneSessionWire(s, prior) };
						}
					}
					if (locked.status !== "draft") {
						throw refuse(
							"intake_not_draft",
							"Canon briefs a draft intake only",
						);
					}
					const row = await insertSession(s, ctx, {
						place: {
							scope: "client",
							clientId,
							engagementId,
							intakeId: params.id,
						},
						mode: "draft",
						limits,
						idempotency: key ? { key, hash } : null,
					});
					return { replayed: false, wire: await oneSessionWire(s, row) };
				}),
			);
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(result.wire) };
			}
			return { status: 201, body: ok(result.wire) };
		},

		createSession: async ({ body }, ctx) => {
			operatorOf(ctx);
			const db = deps.db();
			const limits = ceilingsOf(body);
			if (body.scope === "open") {
				const wire = await withTx(db, (tx) =>
					withOpenScope(tx, async (s) =>
						oneSessionWire(
							s,
							await insertSession(s, ctx, {
								place: {
									scope: "open",
									clientId: null,
									engagementId: null,
									intakeId: null,
								},
								mode: body.mode ?? "ask",
								limits,
								idempotency: null,
							}),
						),
					),
				);
				return { status: 201, body: ok(wire) };
			}
			// The engagement must be the client's, and the intake the
			// engagement's: each is checked against the one above it, all live.
			const clientId = await clientScope(db, body.clientId);
			let engagementId: string | null = null;
			if (body.intakeId) {
				const found = await intakeScope(db, body.intakeId);
				if (
					found.clientId !== clientId ||
					(body.engagementId && body.engagementId !== found.engagementId)
				) {
					throw notFound("intake", body.intakeId);
				}
				engagementId = found.engagementId;
			} else if (body.engagementId) {
				const [eng] = await db
					.select({ id: engagement.id })
					.from(engagement)
					.where(
						and(
							eq(engagement.id, body.engagementId),
							eq(engagement.clientId, clientId),
							live(engagement),
						),
					);
				if (!eng) throw notFound("engagement", body.engagementId);
				engagementId = eng.id;
			}
			const intakeId = body.intakeId ?? null;
			const mode = body.mode ?? (intakeId ? "draft" : "ask");
			if (mode === "draft" && !intakeId) {
				throw refuse(
					"canon_mode_unavailable",
					"Draft mode needs an intake to draft",
				);
			}
			const wire = await withTx(db, (tx) =>
				withClientScope(tx, clientId, async (s) => {
					if (intakeId) {
						const [locked] = await s
							.select({ status: intake.status })
							.from(intake)
							.where(eq(intake.id, intakeId))
							.for("update");
						if (!locked) throw notFound("intake", intakeId);
						if (locked.status !== "draft") {
							throw refuse(
								"intake_not_draft",
								"Canon briefs a draft intake only",
							);
						}
					}
					return oneSessionWire(
						s,
						await insertSession(s, ctx, {
							place: { scope: "client", clientId, engagementId, intakeId },
							mode,
							limits,
							idempotency: null,
						}),
					);
				}),
			);
			return { status: 201, body: ok(wire) };
		},

		listAllSessions: async ({ query }) => {
			const db = deps.db();
			// Across clients, which no scope can read: the one summary function
			// (drizzle/0042), filtered and paged here.
			const index = sql`canon_session_index()`;
			const filters: SQL[] = [
				query.archived
					? sql`archived_at is not null`
					: sql`archived_at is null`,
			];
			if (query.scope) filters.push(sql`scope = ${query.scope}`);
			if (query.clientId) filters.push(sql`client_id = ${query.clientId}`);
			if (query.status) {
				filters.push(
					sql`status in (${sql.join(
						query.status.map((st) => sql`${st}`),
						sql`, `,
					)})`,
				);
			}
			if (query.q) {
				filters.push(sql`title ilike ${containsPattern(query.q)}`);
			}
			const where = sql.join(filters, sql` and `);
			const cursor = query.cursor ? decodeCursor(query.cursor) : null;
			const after = cursor
				? sql`and (last_activity_at, id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
				: sql``;
			const rows = await db.execute<IndexRow>(
				sql`select id, scope, client_id, engagement_id, intake_id, title, mode, status, halt_reason, archived_at, last_activity_at, opened_at, turn_started_at
					from ${index} where ${where} ${after}
					order by last_activity_at desc, id desc limit ${query.limit + 1}`,
			);
			const [counted] = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from ${index} where ${where}`,
			);
			const items = rows.slice(0, query.limit);
			const last = items.at(-1);
			const nextCursor =
				rows.length > query.limit && last
					? encodeCursor({
							createdAt: asDate(last.last_activity_at),
							id: last.id,
						})
					: null;
			return {
				status: 200,
				body: page(items.map(listItemOf), nextCursor, counted?.n ?? 0),
			};
		},

		updateSession: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const wire = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const row = await lockedSession(s, params.id);
					const set: Partial<typeof canonSession.$inferInsert> = {};
					if (body.mode !== undefined && body.mode !== row.mode) {
						if (row.status !== "open") {
							throw refuse(
								"canon_session_not_open",
								"Only an open session's mode changes",
							);
						}
						if (body.mode === "draft" && row.intakeId === null) {
							throw refuse(
								"canon_mode_unavailable",
								"Draft mode needs an intake to draft",
							);
						}
						set.mode = body.mode;
					}
					const renamed =
						body.title !== undefined &&
						(body.title !== row.title || row.titleSetBy !== "operator");
					if (renamed) {
						set.title = body.title;
						set.titleSetBy = "operator";
					}
					if (Object.keys(set).length === 0) return oneSessionWire(s, row);
					const [updated] = await s
						.update(canonSession)
						.set({ ...set, ...touch(deps.clock) })
						.where(eq(canonSession.id, params.id))
						.returning();
					if (!updated)
						throw new Error(`canon_session ${params.id}: no row updated`);
					if (renamed) {
						await logActivity(s, deps, {
							actorKind: "operator",
							actorUserId: operator.id,
							action: "canon_session.renamed",
							entityType: "canon_session",
							entityId: params.id,
							engagementId: row.engagementId,
							clientId: row.clientId,
							requestId: ctx.requestId,
							// The title is client text: never in the log.
							payload: { sessionId: params.id, hadTitle: row.title !== null },
						});
					}
					return oneSessionWire(s, updated);
				}),
			);
			return { status: 200, body: ok(wire) };
		},

		reopenSession: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const wire = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const row = await lockedSession(s, params.id);
					if (row.status === "open") {
						throw refuse("canon_session_open", "This session is already open");
					}
					if (row.status === "halted" && row.haltReason !== "operator") {
						throw refuse(
							"canon_session_final",
							"A session halted at its token ceiling stays halted",
						);
					}
					if (row.intakeId) {
						const [other] = await s
							.select({ id: canonSession.id })
							.from(canonSession)
							.where(
								and(
									eq(canonSession.intakeId, row.intakeId),
									eq(canonSession.status, "open"),
								),
							);
						if (other) {
							throw refuse(
								"canon_session_open",
								"This intake already has an open Canon session",
							);
						}
					}
					const now = deps.clock.now();
					const [updated] = await s
						.update(canonSession)
						.set({
							status: "open",
							haltReason: null,
							closedAt: null,
							archivedAt: null,
							lastActivityAt: now,
							updatedAt: now,
						})
						.where(eq(canonSession.id, params.id))
						.returning();
					if (!updated)
						throw new Error(`canon_session ${params.id}: no row updated`);
					await logActivity(s, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "canon_session.reopened",
						entityType: "canon_session",
						entityId: params.id,
						engagementId: row.engagementId,
						clientId: row.clientId,
						requestId: ctx.requestId,
						payload: {
							sessionId: params.id,
							from: row.status,
							haltReason: row.haltReason,
							closedAt: row.closedAt?.toISOString() ?? null,
							wasArchived: row.archivedAt !== null,
						},
					});
					return oneSessionWire(s, updated);
				}),
			);
			return { status: 200, body: ok(wire) };
		},

		archiveSession: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const wire = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const row = await lockedSession(s, params.id);
					if (row.archivedAt !== null) return oneSessionWire(s, row);
					if (row.turnStartedAt !== null) {
						throw refuse(
							"canon_turn_running",
							"Canon is still replying; halt it instead",
						);
					}
					const now = deps.clock.now();
					const closing = row.status === "open";
					const [updated] = await s
						.update(canonSession)
						.set({
							...(closing ? { status: "closed" as const, closedAt: now } : {}),
							archivedAt: now,
							updatedAt: now,
						})
						.where(eq(canonSession.id, params.id))
						.returning();
					if (!updated)
						throw new Error(`canon_session ${params.id}: no row updated`);
					const actor = {
						actorKind: "operator" as const,
						actorUserId: operator.id,
						entityType: "canon_session" as const,
						entityId: params.id,
						engagementId: row.engagementId,
						clientId: row.clientId,
						requestId: ctx.requestId,
					};
					if (closing) {
						await logActivity(s, deps, {
							...actor,
							action: "canon_session.closed",
							payload: { sessionId: params.id, intakeId: row.intakeId },
						});
					}
					await logActivity(s, deps, {
						...actor,
						action: "canon_session.archived",
						payload: { sessionId: params.id, closed: closing },
					});
					return oneSessionWire(s, updated);
				}),
			);
			return { status: 200, body: ok(wire) };
		},

		unarchiveSession: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const wire = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const row = await lockedSession(s, params.id);
					if (row.archivedAt === null) return oneSessionWire(s, row);
					const [updated] = await s
						.update(canonSession)
						.set({ archivedAt: null, ...touch(deps.clock) })
						.where(eq(canonSession.id, params.id))
						.returning();
					if (!updated)
						throw new Error(`canon_session ${params.id}: no row updated`);
					await logActivity(s, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "canon_session.unarchived",
						entityType: "canon_session",
						entityId: params.id,
						engagementId: row.engagementId,
						clientId: row.clientId,
						requestId: ctx.requestId,
						payload: { sessionId: params.id },
					});
					return oneSessionWire(s, updated);
				}),
			);
			return { status: 200, body: ok(wire) };
		},

		listSteps: async ({ params, query }) => {
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			return withCanonScope(db, scope, async (s) => {
				const rows = await s
					.select()
					.from(canonStep)
					.where(
						and(
							eq(canonStep.canonSessionId, params.id),
							gt(canonStep.seq, query.afterSeq),
						),
					)
					.orderBy(asc(canonStep.seq))
					.limit(query.limit);
				const [last] = await s
					.select({ seq: max(canonStep.seq) })
					.from(canonStep)
					.where(eq(canonStep.canonSessionId, params.id));
				return {
					status: 200,
					body: {
						success: true as const,
						data: rows.map(stepWire),
						meta: { lastSeq: last?.seq ?? 0 },
					},
				};
			});
		},

		listSessions: async ({ params, query }) => {
			const db = deps.db();
			const { clientId } = await intakeScope(db, params.id);
			return withClientScope(db, clientId, async (s) => {
				const filters = eq(canonSession.intakeId, params.id);
				const rows = await s
					.select()
					.from(canonSession)
					.where(and(filters, after(canonSession, query.cursor)))
					.orderBy(desc(canonSession.createdAt), desc(canonSession.id))
					.limit(query.limit + 1);
				const [counted] = await s
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(canonSession)
					.where(filters);
				const { items, nextCursor } = toPage(rows, query.limit);
				return {
					status: 200,
					body: page(await sessionWires(s, items), nextCursor, counted?.n ?? 0),
				};
			});
		},

		getSession: async ({ params }) => {
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			return withCanonScope(db, scope, async (s) => {
				const [row] = await s
					.select()
					.from(canonSession)
					.where(eq(canonSession.id, params.id));
				if (!row) throw notFound("canon session", params.id);
				return { status: 200, body: ok(await oneSessionWire(s, row)) };
			});
		},

		closeSession: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const wire = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const row = await lockedSession(s, params.id);
					if (row.status !== "open") {
						throw refuse("canon_session_not_open", "This session is not open");
					}
					if (row.turnStartedAt !== null) {
						throw refuse(
							"canon_turn_running",
							"Canon is still replying; halt it instead",
						);
					}
					const now = deps.clock.now();
					const [updated] = await s
						.update(canonSession)
						.set({ status: "closed", closedAt: now, updatedAt: now })
						.where(eq(canonSession.id, params.id))
						.returning();
					if (!updated)
						throw new Error(`canon_session ${params.id}: no row updated`);
					await logActivity(s, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "canon_session.closed",
						entityType: "canon_session",
						entityId: params.id,
						engagementId: row.engagementId,
						clientId: row.clientId,
						requestId: ctx.requestId,
						payload: { sessionId: params.id, intakeId: row.intakeId },
					});
					return oneSessionWire(s, updated);
				}),
			);
			return { status: 200, body: ok(wire) };
		},

		haltSession: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const wire = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const row = await lockedSession(s, params.id);
					if (row.status !== "open") {
						throw refuse("canon_session_not_open", "This session is not open");
					}
					const now = deps.clock.now();
					const [updated] = await s
						.update(canonSession)
						.set({
							status: "halted",
							haltReason: "operator",
							closedAt: now,
							turnStartedAt: null,
							updatedAt: now,
						})
						.where(eq(canonSession.id, params.id))
						.returning();
					if (!updated)
						throw new Error(`canon_session ${params.id}: no row updated`);
					await logActivity(s, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "canon_session.halted",
						entityType: "canon_session",
						entityId: params.id,
						engagementId: row.engagementId,
						clientId: row.clientId,
						requestId: ctx.requestId,
						payload: {
							sessionId: params.id,
							intakeId: row.intakeId,
							haltReason: "operator",
							midTurn: row.turnStartedAt !== null,
						},
					});
					return oneSessionWire(s, updated);
				}),
			);
			return { status: 200, body: ok(wire) };
		},

		listMessages: async ({ params, query }) => {
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			return withCanonScope(db, scope, async (s) => {
				const [session] = await s
					.select({ intakeId: canonSession.intakeId })
					.from(canonSession)
					.where(eq(canonSession.id, params.id));
				if (!session) throw notFound("canon session", params.id);
				const rows = await s
					.select()
					.from(canonMessage)
					.where(
						and(
							eq(canonMessage.canonSessionId, params.id),
							gt(canonMessage.seq, query.afterSeq),
						),
					)
					.orderBy(asc(canonMessage.seq))
					.limit(query.limit);
				const [last] = await s
					.select({ seq: max(canonMessage.seq) })
					.from(canonMessage)
					.where(eq(canonMessage.canonSessionId, params.id));
				return {
					status: 200,
					body: {
						success: true as const,
						data: await messageWires(s, session.intakeId, rows),
						meta: { lastSeq: last?.seq ?? 0 },
					},
				};
			});
		},

		postMessage: async ({ params, headers, body }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await sessionScopeOr404(db, params.id);
			const key = headers["idempotency-key"];
			// A body without a mode hashes as it did before modes existed, so an
			// earlier key still replays.
			const hash = requestSha256(
				body.mode === undefined
					? { contentMd: body.contentMd }
					: { contentMd: body.contentMd, mode: body.mode },
			);
			const result = await withTx(db, (tx) =>
				withCanonScope(tx, scope, async (s) => {
					const session = await lockedSession(s, params.id);
					if (key) {
						const [prior] = await s
							.select()
							.from(canonMessage)
							.where(
								and(
									eq(canonMessage.canonSessionId, params.id),
									eq(canonMessage.idempotencyKey, key),
								),
							);
						if (prior) {
							if (prior.requestSha256 !== hash) {
								throw new ApiError(
									"IDEMPOTENCY_REPLAY",
									"This Idempotency-Key was used with a different body",
								);
							}
							const [wire] = await messageWires(s, session.intakeId, [prior]);
							return { replayed: true, wire };
						}
					}
					if (session.status !== "open") {
						throw refuse("canon_session_not_open", "This session is not open");
					}
					const mode = body.mode ?? session.mode;
					if (mode === "draft" && session.intakeId === null) {
						throw refuse(
							"canon_mode_unavailable",
							"Draft mode needs an intake to draft",
						);
					}
					const now = deps.clock.now();
					// The turn starts here, or not at all: one statement decides, so
					// two posts cannot both start one.
					const started = await s
						.update(canonSession)
						.set({ turnStartedAt: now, lastActivityAt: now, updatedAt: now })
						.where(
							and(
								eq(canonSession.id, params.id),
								eq(canonSession.status, "open"),
								isNull(canonSession.turnStartedAt),
							),
						)
						.returning({ id: canonSession.id });
					if (started.length === 0) {
						throw refuse("canon_turn_running", "Canon is still replying");
					}
					const [last] = await s
						.select({ seq: max(canonMessage.seq) })
						.from(canonMessage)
						.where(eq(canonMessage.canonSessionId, params.id));
					const [row] = await s
						.insert(canonMessage)
						.values({
							id: deps.ids.next(),
							canonSessionId: params.id,
							clientId: session.clientId,
							seq: (last?.seq ?? 0) + 1,
							role: "operator",
							mode,
							contentMd: body.contentMd,
							citations: [],
							parts: [],
							idempotencyKey: key ?? null,
							requestSha256: key ? hash : null,
							createdAt: now,
						})
						.returning();
					if (!row) throw new Error("canon_message insert returned no row");
					await logActivity(s, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "canon_message.posted",
						entityType: "canon_session",
						entityId: params.id,
						engagementId: session.engagementId,
						clientId: session.clientId,
						requestId: ctx.requestId,
						// Never the text: ids, the seq and the mode only.
						payload: {
							sessionId: params.id,
							messageId: row.id,
							seq: row.seq,
							mode,
						},
					});
					const [wire] = await messageWires(s, session.intakeId, [row]);
					return { replayed: false, wire };
				}),
			);
			if (!result.wire) throw new Error("canon_message: no wire");
			if (result.replayed) {
				ctx.responseHeaders.set(REPLAYED, "true");
				return { status: 200, body: ok(result.wire) };
			}
			return { status: 202, body: ok(result.wire) };
		},

		listQuestions: async ({ params, query }) => {
			const db = deps.db();
			const { clientId } = await intakeScope(db, params.id);
			return withClientScope(db, clientId, async (s) => {
				const filters = and(
					eq(canonQuestion.intakeId, params.id),
					query.status
						? inArray(canonQuestion.status, query.status)
						: undefined,
				);
				const rows = await s
					.select()
					.from(canonQuestion)
					.where(and(filters, afterAscending(canonQuestion, query.cursor)))
					.orderBy(asc(canonQuestion.createdAt), asc(canonQuestion.id))
					.limit(query.limit + 1);
				const [counted] = await s
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(canonQuestion)
					.where(filters);
				const byStatus = await s
					.select({
						status: canonQuestion.status,
						n: sql<number>`count(*)`.mapWith(Number),
					})
					.from(canonQuestion)
					.where(eq(canonQuestion.intakeId, params.id))
					.groupBy(canonQuestion.status);
				const counts = { open: 0, answered: 0, acknowledged: 0, dismissed: 0 };
				for (const c of byStatus) counts[c.status] = c.n;
				const { items, nextCursor } = toPage(rows, query.limit);
				return {
					status: 200,
					body: {
						success: true as const,
						data: await questionWires(s, items),
						meta: { nextCursor, total: counted?.n ?? 0, counts },
					},
				};
			});
		},

		answerQuestion: async ({ params, body }, ctx) => {
			const answer = {
				selected: body.selected,
				...(body.other === undefined ? {} : { other: body.other }),
			};
			const wire = await decide(ctx, params.id, "answered", {
				answer,
				...(body.effectMd === undefined ? {} : { effectMd: body.effectMd }),
			});
			return { status: 200, body: ok(wire) };
		},

		acknowledgeQuestion: async ({ params, body }, ctx) => {
			const wire = await decide(ctx, params.id, "acknowledged", {
				...(body.effectMd === undefined ? {} : { effectMd: body.effectMd }),
			});
			return { status: 200, body: ok(wire) };
		},

		dismissQuestion: async ({ params, body }, ctx) => {
			const wire = await decide(ctx, params.id, "dismissed", {
				...(body.effectMd === undefined ? {} : { effectMd: body.effectMd }),
			});
			return { status: 200, body: ok(wire) };
		},

		listMemory: async ({ params, query }) => {
			const db = deps.db();
			const scope = await clientScope(db, params.id);
			return withClientScope(db, scope, async (s) => {
				const filters = and(
					eq(clientMemory.clientId, params.id),
					query.status ? inArray(clientMemory.status, query.status) : undefined,
				);
				const rows = await s
					.select()
					.from(clientMemory)
					.where(and(filters, after(clientMemory, query.cursor)))
					.orderBy(desc(clientMemory.createdAt), desc(clientMemory.id))
					.limit(query.limit + 1);
				const [counted] = await s
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(clientMemory)
					.where(filters);
				const { items, nextCursor } = toPage(rows, query.limit);
				return {
					status: 200,
					body: page(await memoryWires(s, items), nextCursor, counted?.n ?? 0),
				};
			});
		},

		writeMemory: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const db = deps.db();
			const scope = await clientScope(db, params.id);
			const wire = await withTx(db, (tx) =>
				withClientScope(tx, scope, async (s) => {
					const now = deps.clock.now();
					const [row] = await s
						.insert(clientMemory)
						.values({
							id: deps.ids.next(),
							clientId: params.id,
							contentMd: body.contentMd,
							status: "kept",
							proposedByCanonSessionId: null,
							decidedBy: operator.id,
							decidedAt: now,
							...stamp(deps.clock),
						})
						.returning();
					if (!row) throw new Error("client_memory insert returned no row");
					await logActivity(s, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "client_memory.written",
						entityType: "client_memory",
						entityId: row.id,
						clientId: row.clientId,
						requestId: ctx.requestId,
						payload: {
							memoryId: row.id,
							clientId: params.id,
							status: "kept",
							contentSha256: sha(body.contentMd),
						},
					});
					return oneOf(memoryWires(s, [row]));
				}),
			);
			return { status: 201, body: ok(wire) };
		},

		keepMemory: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const wire = await changeMemory(ctx, params.id, (row) => {
				if (row.status !== "proposed") {
					throw refuse(
						"client_memory_not_proposed",
						"Only a proposed memory can be kept",
					);
				}
				return {
					set: {
						status: "kept",
						decidedBy: operator.id,
						decidedAt: deps.clock.now(),
					},
					action: "client_memory.kept",
					payload: { status: "kept", from: row.status },
				};
			});
			return { status: 200, body: ok(wire) };
		},

		removeMemory: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const wire = await changeMemory(ctx, params.id, (row) =>
				// Already removed: nothing changes, so nothing is logged.
				row.status === "removed"
					? null
					: {
							set: {
								status: "removed",
								decidedBy: operator.id,
								decidedAt: deps.clock.now(),
							},
							action: "client_memory.removed",
							payload: { status: "removed", from: row.status },
						},
			);
			return { status: 200, body: ok(wire) };
		},

		editMemory: async ({ params, body }, ctx) => {
			const wire = await changeMemory(ctx, params.id, (row) => {
				if (row.status === "removed") {
					throw refuse(
						"client_memory_removed",
						"A removed memory cannot be edited",
					);
				}
				return {
					set: { contentMd: body.contentMd },
					action: "client_memory.edited",
					payload: { status: row.status, contentSha256: sha(body.contentMd) },
				};
			});
			return { status: 200, body: ok(wire) };
		},
	});
}
