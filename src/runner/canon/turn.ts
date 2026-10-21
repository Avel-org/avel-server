import { and, asc, eq, isNotNull, isNull, max } from "drizzle-orm";
import type { CanonMode } from "../../contract";
import { logActivity } from "../../db/activity";
import { CANON_TURN_MAX_MS, canonScopes } from "../../db/canon";
import { clientIdOfIntake } from "../../db/client-id";
import {
	agentIdentityVersion,
	canonMessage,
	canonSession,
	clientMemory,
	file,
	intakeFiles,
} from "../../db/schema";
import type { Citation } from "../../db/schema/canon";
import { touch } from "../../db/schema/columns";
import {
	type CanonScope,
	type Executor,
	scopeClientId,
	withCanonScope,
} from "../../db/tx";
import type { BlobStore } from "../../gateways/blob";
import {
	type CanonCitation,
	type KnowledgeChunk,
	type KnowledgeFile,
	parseSource,
	validateCitations,
} from "../../lib/canon";
import type { Clock } from "../../lib/clock";
import type { IdGenerator } from "../../lib/ids";
import type { Logger } from "../../lib/logger";
import type { TokenSplit } from "../../lib/prices";
import { addUsage, type PriceBook, tableFor } from "../budget";
import { CANON_TOOL_NAMES, type CanonModel, type CanonToolName } from "./model";
import { buildCanonPrompt } from "./prompt";
import { canonTools } from "./tools";

/**
 * One Canon turn (DECISIONS-V2, Decided 2026-10-19: Canon is the briefer):
 * the operator's message set canon_session.turn_started_at, and the runner
 * answers it here. Every way a turn ends clears turn_started_at in its own
 * transaction: a reply, an end with no reply (Canon asked or drafted
 * through its tools), a failure, or a halt at the hard ceiling.
 *
 * Everything runs in the session's client scope (row-level security), and
 * the client is the caller's, derived from the server's rows.
 */

export type CanonDeps = {
	db: () => Executor;
	clock: Clock;
	ids: IdGenerator;
	prices: PriceBook;
	blobs: BlobStore;
	model: CanonModel;
	logger: Logger;
	/** BE-worker2's sweepStuckCanonTurns; the tick calls it first when given. */
	sweepStuckTurns?: (
		db: Executor,
		clock: Clock,
		maxMs: number,
	) => Promise<unknown>;
};

export type TurnOutcome = "replied" | "ended" | "halted" | "failed" | "skipped";

export type TurnResult = { outcome: TurnOutcome; promptSha256: string | null };

/** Only text files are read into the prompt. Others are left out of it. [hypothesis] */
const TEXT_MIME = /^text\//;

class TurnFailed extends Error {}

/**
 * The sweep, then one turn for every open session mid-turn, scope by scope:
 * canon_session is under row-level security, so it is read in the open
 * scope, then in each client's own. Scopes and sessions run in a stable order.
 */
export async function canonTick(deps: CanonDeps): Promise<TurnResult[]> {
	if (deps.sweepStuckTurns) {
		await deps.sweepStuckTurns(deps.db(), deps.clock, CANON_TURN_MAX_MS);
	}
	const results: TurnResult[] = [];
	for (const scope of await canonScopes(deps.db())) {
		const pending = await withCanonScope(deps.db(), scope, (tx) =>
			tx
				.select({ id: canonSession.id })
				.from(canonSession)
				.where(
					and(
						eq(canonSession.status, "open"),
						isNotNull(canonSession.turnStartedAt),
					),
				)
				.orderBy(asc(canonSession.turnStartedAt), asc(canonSession.id)),
		);
		for (const p of pending)
			results.push(await runCanonTurn(deps, scope, p.id));
	}
	return results;
}

/** Reads one turn's inputs in the client's scope; null when there is no turn to run. */
async function loadTurn(deps: CanonDeps, scope: CanonScope, sessionId: string) {
	const clientId = scopeClientId(scope);
	return withCanonScope(deps.db(), scope, async (tx) => {
		const [session] = await tx
			.select()
			.from(canonSession)
			.where(
				and(
					eq(canonSession.id, sessionId),
					clientId === null
						? isNull(canonSession.clientId)
						: eq(canonSession.clientId, clientId),
				),
			);
		if (
			!session ||
			session.status !== "open" ||
			session.turnStartedAt === null
		) {
			return null;
		}
		if (
			session.intakeId !== null &&
			(await clientIdOfIntake(tx, session.intakeId)) !== clientId
		) {
			throw new Error(`session ${sessionId}'s intake is not this client's`);
		}
		const [identity] = await tx
			.select({ identityMd: agentIdentityVersion.identityMd })
			.from(agentIdentityVersion)
			.where(eq(agentIdentityVersion.id, session.agentIdentityVersionId));
		if (!identity) throw new Error(`session ${sessionId} has no identity`);
		// Only a session on an intake has documents, and only a client's
		// session has memory: an open session reads no client's data.
		const files =
			session.intakeId === null
				? []
				: await tx
						.select({
							id: file.id,
							name: file.name,
							mime: file.mime,
							sha256: file.sha256,
							storageKey: file.storageKey,
							purgedAt: file.purgedAt,
							deletedAt: file.deletedAt,
						})
						.from(intakeFiles)
						.innerJoin(file, eq(file.id, intakeFiles.fileId))
						.where(eq(intakeFiles.intakeId, session.intakeId))
						.orderBy(asc(file.createdAt), asc(file.id));
		const memory =
			clientId === null
				? []
				: await tx
						.select({ contentMd: clientMemory.contentMd })
						.from(clientMemory)
						.where(
							and(
								eq(clientMemory.clientId, clientId),
								eq(clientMemory.status, "kept"),
							),
						)
						.orderBy(asc(clientMemory.createdAt), asc(clientMemory.id));
		const messages = await tx
			.select({
				seq: canonMessage.seq,
				role: canonMessage.role,
				mode: canonMessage.mode,
				contentMd: canonMessage.contentMd,
			})
			.from(canonMessage)
			.where(eq(canonMessage.canonSessionId, sessionId))
			.orderBy(asc(canonMessage.seq));
		// The turn is the operator's last message: its seq names the turn,
		// and its mode decides the tools.
		const asked = messages.findLast((m) => m.role === "operator");
		if (!asked) {
			throw new Error(`session ${sessionId} is mid-turn with no message`);
		}
		return {
			session,
			turn: { seq: asked.seq, mode: asked.mode },
			identityMd: identity.identityMd,
			files: files.filter(
				(f) =>
					f.deletedAt === null && f.purgedAt === null && f.storageKey !== null,
			),
			memory: memory.map((m) => m.contentMd),
			messages: messages.map(({ seq, role, contentMd }) => ({
				seq,
				role,
				contentMd,
			})),
		};
	});
}

/** The live text files' bytes, through the blob gateway. A missing blob fails the turn. */
async function readFiles(
	blobs: BlobStore,
	files: ReadonlyArray<{
		id: string;
		name: string;
		mime: string;
		sha256: string;
		storageKey: string | null;
	}>,
): Promise<KnowledgeFile[]> {
	const out: KnowledgeFile[] = [];
	for (const f of files) {
		if (!TEXT_MIME.test(f.mime) || f.storageKey === null) continue;
		const bytes = await blobs.get(f.storageKey);
		if (bytes === null) throw new TurnFailed(`file ${f.id} has no bytes`);
		let contentMd: string;
		try {
			contentMd = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			continue;
		}
		out.push({ fileId: f.id, sha256: f.sha256, name: f.name, contentMd });
	}
	return out;
}

/** Clears the turn, in its own transaction. */
async function clearTurn(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
) {
	await withCanonScope(deps.db(), scope, (tx) =>
		tx
			.update(canonSession)
			.set({ turnStartedAt: null, ...touch(deps.clock) })
			.where(
				and(
					eq(canonSession.id, sessionId),
					isNotNull(canonSession.turnStartedAt),
				),
			),
	);
}

/**
 * Counts one usage step at the session's frozen price version. At the hard
 * ceiling the session halts (token_hard_ceiling), closes and its turn
 * clears, in the same transaction. Returns whether it halted.
 */
async function applyCanonUsage(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
	split: TokenSplit,
): Promise<boolean> {
	return withCanonScope(deps.db(), scope, async (tx) => {
		const [s] = await tx
			.select()
			.from(canonSession)
			.where(eq(canonSession.id, sessionId))
			.for("update");
		if (!s || s.status !== "open") return true;
		const table = tableFor(deps.prices, s.priceVersion);
		if (!table)
			throw new Error(`session ${s.id} has no price table ${s.priceVersion}`);
		const next = addUsage(
			{
				...s,
				softCeilingCrossed: s.tokensUsed >= s.tokenSoftCeiling,
			},
			split,
			table,
		);
		const now = deps.clock.now();
		await tx
			.update(canonSession)
			.set({
				tokensIn: next.tokensIn,
				tokensOut: next.tokensOut,
				cacheReadTokens: next.cacheReadTokens,
				cacheWriteTokens: next.cacheWriteTokens,
				tokensUsed: next.tokensUsed,
				spendUsd: next.spendUsd,
				...(next.hardReached
					? {
							status: "halted" as const,
							haltReason: "token_hard_ceiling" as const,
							closedAt: now,
							turnStartedAt: null,
						}
					: {}),
				...touch(deps.clock),
			})
			.where(eq(canonSession.id, s.id));
		if (next.hardReached) {
			await logActivity(tx, deps, {
				actorKind: "system",
				action: "canon_session.halted",
				entityType: "canon_session",
				entityId: s.id,
				engagementId: s.engagementId,
				requestId: deps.ids.next(),
				payload: {
					haltReason: "token_hard_ceiling",
					tokensUsed: next.tokensUsed,
					tokenHardCeiling: s.tokenHardCeiling,
				},
			});
		}
		return next.hardReached;
	});
}

/** Each citation as stored: its chunk, heading path and quote. Throws on one that does not hold. */
function storedCitations(
	citations: readonly CanonCitation[],
	chunks: readonly KnowledgeChunk[],
): Citation[] {
	const bad = validateCitations(citations, chunks).filter(
		(c) => c.status !== "ok",
	);
	if (bad.length > 0) {
		throw new TurnFailed(
			`${bad.length} of ${citations.length} citations do not hold: ${bad.map((c) => c.status).join(", ")}`,
		);
	}
	return citations.map((c) => {
		const named = parseSource(c.source);
		const chunk = chunks.find(
			(k) => k.fileId === named?.fileId && k.chunkId === named?.chunkId,
		);
		if (!chunk) throw new TurnFailed("a validated citation lost its chunk");
		return {
			chunkId: chunk.chunkId,
			heading: chunk.headingPath,
			quote: c.cited_text.replace(/\r\n?/g, "\n"),
		};
	});
}

/** Stores Canon's reply as the next message and ends the turn, in one transaction. */
async function storeReply(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
	mode: CanonMode,
	text: string,
	citations: Citation[],
): Promise<boolean> {
	return withCanonScope(deps.db(), scope, async (tx) => {
		const [s] = await tx
			.select({
				status: canonSession.status,
				turnStartedAt: canonSession.turnStartedAt,
			})
			.from(canonSession)
			.where(eq(canonSession.id, sessionId))
			.for("update");
		// The sweep may have ended a turn that ran too long: its reply is not stored.
		if (!s || s.status !== "open" || s.turnStartedAt === null) return false;
		const [last] = await tx
			.select({ seq: max(canonMessage.seq) })
			.from(canonMessage)
			.where(eq(canonMessage.canonSessionId, sessionId));
		await tx.insert(canonMessage).values({
			id: deps.ids.next(),
			canonSessionId: sessionId,
			clientId: scopeClientId(scope),
			seq: (last?.seq ?? 0) + 1,
			role: "canon",
			mode,
			contentMd: text,
			citations,
			parts: [],
			createdAt: deps.clock.now(),
		});
		await tx
			.update(canonSession)
			.set({
				turnStartedAt: null,
				lastActivityAt: deps.clock.now(),
				...touch(deps.clock),
			})
			.where(eq(canonSession.id, sessionId));
		return true;
	});
}

/**
 * Each mode's tools (J, 2026-10-20: the server enforces them). Ask reads
 * only what the prompt holds. Draft writes the intake's brief, questions,
 * memory and roster, so it needs a client session on an intake. Fetch's
 * read tools come with the next slice; until then a fetch post is refused
 * at the route, so no fetch turn reaches here.
 */
export function toolsFor(
	mode: CanonMode,
	session: { clientId: string | null; intakeId: string | null },
): readonly CanonToolName[] {
	if (mode !== "draft") return [];
	if (session.clientId === null || session.intakeId === null) return [];
	return CANON_TOOL_NAMES;
}

/** The callTool for a turn with no tools: every call is the tool's error. */
const noTools = async (name: CanonToolName) => ({
	text: `${name} is not available in this mode`,
	isError: true,
});

/**
 * Runs one turn of the session, if it is open and mid-turn in this scope;
 * otherwise "skipped". A citation that names no passage of this turn's
 * knowledge, or misquotes one, fails the turn: no reply is stored.
 */
export async function runCanonTurn(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
): Promise<TurnResult> {
	const turn = await loadTurn(deps, scope, sessionId);
	if (!turn) return { outcome: "skipped", promptSha256: null };
	const log = deps.logger.child({ canonSessionId: sessionId });
	let promptSha256: string | null = null;
	const abort = new AbortController();
	try {
		const files = await readFiles(deps.blobs, turn.files);
		const built = buildCanonPrompt({
			identityMd: turn.identityMd,
			files,
			memory: turn.memory,
			messages: turn.messages,
		});
		promptSha256 = built.sha256;
		const tools = toolsFor(turn.turn.mode, turn.session);
		const clientId = scopeClientId(scope);
		const intakeId = turn.session.intakeId;
		const engagementId = turn.session.engagementId;
		const callTool =
			tools.length > 0 &&
			clientId !== null &&
			intakeId !== null &&
			engagementId !== null
				? canonTools({
						db: deps.db,
						clock: deps.clock,
						ids: deps.ids,
						clientId,
						session: { id: turn.session.id, intakeId, engagementId },
						chunkIds: new Set(built.chunks.map((c) => c.chunkId)),
						requestId: deps.ids.next(),
					})
				: noTools;
		for await (const event of deps.model.run({
			sessionId,
			model: turn.session.model,
			prompt: built.prompt,
			tools,
			callTool: async (name, input) =>
				tools.includes(name) ? callTool(name, input) : noTools(name),
			signal: abort.signal,
		})) {
			if (event.kind === "usage") {
				if (await applyCanonUsage(deps, scope, sessionId, event.split)) {
					abort.abort();
					log.info({ promptSha256 }, "canon turn halted at the hard ceiling");
					return { outcome: "halted", promptSha256 };
				}
			} else {
				const citations = storedCitations(event.citations, built.chunks);
				const stored = await storeReply(
					deps,
					scope,
					sessionId,
					turn.turn.mode,
					event.text,
					citations,
				);
				abort.abort();
				log.info({ promptSha256, stored }, "canon turn replied");
				return { outcome: stored ? "replied" : "skipped", promptSha256 };
			}
		}
		await clearTurn(deps, scope, sessionId);
		log.info({ promptSha256 }, "canon turn ended without a reply");
		return { outcome: "ended", promptSha256 };
	} catch (err) {
		abort.abort();
		log.error(
			{ err: err instanceof Error ? err.message : String(err), promptSha256 },
			"canon turn failed",
		);
		await clearTurn(deps, scope, sessionId);
		return { outcome: "failed", promptSha256 };
	}
}
