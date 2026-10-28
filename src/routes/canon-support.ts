import { and, asc, eq, gt, inArray, max, or, type SQL, sql } from "drizzle-orm";
import type {
	CanonCitation,
	CanonMessage,
	CanonMode,
	CanonQuestion,
	CanonSession,
	CanonSessionListItem,
	ClientMemory,
	PreconditionReason,
	RunStep,
} from "../contract";
import {
	type ClientId,
	canonSessionScope,
	clientIdOfClient,
	clientIdOfIntake,
} from "../db/client-id";
import {
	canonMessage,
	canonQuestion,
	canonSession,
	type canonStep,
	client,
	clientMemory,
	engagement,
	file,
	intake,
	intakeFiles,
	user,
} from "../db/schema";
import { live } from "../db/schema/columns";
import type { CanonScope, Executor, Tx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import { activityActor } from "./activity";
import { asDate, decodeCursor, notFound } from "./shared";

// The pieces Canon's routes are built from (src/routes/canon.ts): scope
// lookups, actors, the row-to-wire mappings and row locks.

export function refuse(reason: PreconditionReason, message: string): ApiError {
	return new ApiError("PRECONDITION_FAILED", message, {
		details: { reason },
	});
}

/** The live intake (engagement and client live too), its client, or 404. */
export async function intakeScope(db: Executor, intakeId: string) {
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
export async function clientScope(
	db: Executor,
	clientId: string,
): Promise<ClientId> {
	const [row] = await db
		.select({ id: client.id })
		.from(client)
		.where(and(eq(client.id, clientId), live(client)));
	const scope = row ? await clientIdOfClient(db, clientId) : null;
	if (!scope) throw notFound("client", clientId);
	return scope;
}

/** The session's scope (a client's, or open), or 404. */
export async function sessionScopeOr404(
	db: Executor,
	id: string,
): Promise<CanonScope> {
	const scope = await canonSessionScope(db, id);
	if (!scope) throw notFound("canon session", id);
	return scope;
}

export async function scopeOr404(
	lookup: Promise<ClientId | null>,
	entity: string,
	id: string,
): Promise<ClientId> {
	const scope = await lookup;
	if (!scope) throw notFound(entity, id);
	return scope;
}

/** The keyset after a cursor, ascending: (created_at asc, id asc). */
export function afterAscending(
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

export const operatorActor = (
	rowId: string,
	userId: string,
	login: string | null,
) =>
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

export const canonActor = (rowId: string, sessionId: string) =>
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

export async function loginsOf(tx: Tx, userIds: readonly (string | null)[]) {
	const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
	if (ids.length === 0) return new Map<string, string>();
	const rows = await tx
		.select({ id: user.id, login: user.githubLogin })
		.from(user)
		.where(inArray(user.id, ids));
	return new Map(rows.map((r) => [r.id, r.login]));
}

export type ResolvedFile = {
	fileId: string;
	fileName: string;
	purged: boolean;
};

/**
 * Each chunk's file, by the chunk's sha256, among the intake's files. Where
 * two files share the bytes, a live one wins over a purged one, then the
 * oldest. A hash none of them has is a broken invariant (the harness checks
 * chunk ids at write, and nothing unlinks an intake's files): a 500, never
 * a made-up file.
 */
export async function resolveChunks(
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

export function fileOf(resolved: Map<string, ResolvedFile>, chunkId: string) {
	const found = resolved.get(chunkId.split(":")[0] ?? "");
	if (!found) throw new Error(`chunk ${chunkId} did not resolve`);
	return found;
}

export type SessionRow = typeof canonSession.$inferSelect;

/** The wire's halt reason. A CHECK refuses spend_ceiling, so reading one is a broken row. */
export function wireHaltReason(r: SessionRow): CanonSession["haltReason"] {
	if (r.haltReason === "spend_ceiling") {
		throw new Error(`canon_session ${r.id}: halted at a spend ceiling`);
	}
	return r.haltReason;
}

/** Sessions to the wire: their last seq, open questions and opener read alongside. */
export async function sessionWires(
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

export async function oneSessionWire(tx: Tx, row: SessionRow) {
	const [wire] = await sessionWires(tx, [row]);
	if (!wire) throw new Error(`canon_session ${row.id}: no wire`);
	return wire;
}

export type MessageRow = typeof canonMessage.$inferSelect;

export async function messageWires(
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
export type IndexRow = {
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

export function listItemOf(r: IndexRow): CanonSessionListItem {
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

export type StepRow = typeof canonStep.$inferSelect;

export function stepWire(r: StepRow): RunStep {
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

export type QuestionRow = typeof canonQuestion.$inferSelect;

export async function questionWires(
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

export type MemoryRow = typeof clientMemory.$inferSelect;

export async function memoryWires(
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

export async function oneOf<T>(wires: Promise<T[]>): Promise<T> {
	const [wire] = await wires;
	if (!wire) throw new Error("expected one wire");
	return wire;
}

/** The row under the scope, locked, or 404: what the lookup said must hold here too. */
export async function lockedSession(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(canonSession)
		.where(eq(canonSession.id, id))
		.for("update");
	if (!row) throw notFound("canon session", id);
	return row;
}

export async function lockedQuestion(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(canonQuestion)
		.where(eq(canonQuestion.id, id))
		.for("update");
	if (!row) throw notFound("canon question", id);
	return row;
}

export async function lockedMemory(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(clientMemory)
		.where(eq(clientMemory.id, id))
		.for("update");
	if (!row) throw notFound("client memory", id);
	return row;
}
