import { and, asc, eq, isNotNull, isNull, max } from "drizzle-orm";
import { z } from "zod";
import type { CanonMode, CanonPart } from "../../contract";
import type { CanonStepKind } from "../../contract/canon";
import { logActivity } from "../../db/activity";
import { CANON_TURN_MAX_MS, canonScopes } from "../../db/canon";
import { clientIdOfIntake } from "../../db/client-id";
import {
	agentIdentityVersion,
	canonMessage,
	canonSession,
	canonStep,
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
import { DOCX_MIME, documentText, PDF_MIME } from "../../lib/documents";
import type { IdGenerator } from "../../lib/ids";
import type { Logger } from "../../lib/logger";
import type { TokenSplit } from "../../lib/prices";
import { addUsage, type PriceBook, tableFor } from "../budget";
import { fetchData } from "./fetch";
import {
	type CanonModel,
	type CanonToolName,
	DRAFT_TOOL_NAMES,
	type ToolResult,
} from "./model";
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

/**
 * How a turn ended. `repeated`: a run of this turn already began (its claim
 * is stored), so the model was not called again; the sweep ends it.
 */
export type TurnOutcome =
	| "replied"
	| "ended"
	| "halted"
	| "failed"
	| "skipped"
	| "repeated";

export type TurnResult = { outcome: TurnOutcome; promptSha256: string | null };

/** Text files are read into the prompt as they are, PDF and Word files as their text. Others are left out of it. [hypothesis] */
const TEXT_MIME = /^text\//;

class TurnFailed extends Error {}

/**
 * A PDF's or Word file's text by its bytes' sha256, so a turn does not
 * parse every document again. The sha names the bytes, so a hit is the
 * same text a parse would give. The oldest entry goes past 32.
 */
const documentTexts = new Map<
	string,
	Awaited<ReturnType<typeof documentText>>
>();
const DOCUMENT_TEXTS_MAX = 32;

async function cachedDocumentText(
	sha256: string,
	bytes: Uint8Array,
	mime: typeof PDF_MIME | typeof DOCX_MIME,
) {
	const key = `${mime}:${sha256}`;
	const hit = documentTexts.get(key);
	if (hit) return hit;
	const read = await documentText(bytes, mime);
	documentTexts.set(key, read);
	if (documentTexts.size > DOCUMENT_TEXTS_MAX) {
		const oldest = documentTexts.keys().next().value;
		if (oldest !== undefined) documentTexts.delete(oldest);
	}
	return read;
}

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

/**
 * The live files' text, through the blob gateway. A missing blob fails the
 * turn. A file whose text cannot be read is left out, and logged by id, so
 * the operator can see Canon answered without it.
 */
async function readFiles(
	blobs: BlobStore,
	files: ReadonlyArray<{
		id: string;
		name: string;
		mime: string;
		sha256: string;
		storageKey: string | null;
	}>,
	log: Logger,
): Promise<KnowledgeFile[]> {
	const out: KnowledgeFile[] = [];
	for (const f of files) {
		const document =
			f.mime === PDF_MIME || f.mime === DOCX_MIME ? f.mime : null;
		if ((!TEXT_MIME.test(f.mime) && !document) || f.storageKey === null) {
			continue;
		}
		const bytes = await blobs.get(f.storageKey);
		if (bytes === null) throw new TurnFailed(`file ${f.id} has no bytes`);
		let contentMd: string;
		if (document) {
			// The upload refused one with no text, so this is a parser or a
			// limit that changed since the upload.
			const read = await cachedDocumentText(f.sha256, bytes, document);
			if ("refused" in read) {
				log.warn(
					{ fileId: f.id, mime: f.mime, refused: read.refused },
					"Canon left out a file whose text could not be read",
				);
				continue;
			}
			contentMd = read.text;
		} else {
			try {
				contentMd = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				log.warn(
					{ fileId: f.id, mime: f.mime },
					"Canon left out a file that is not UTF-8",
				);
				continue;
			}
		}
		out.push({ fileId: f.id, sha256: f.sha256, name: f.name, contentMd });
	}
	return out;
}

/**
 * Claims the turn before the model runs, in its own transaction: stores its
 * seq and its prompt's hash on the session. "claimed" when this run may go
 * on; "repeated" when a run of this same turn already claimed it (it died
 * before the turn's end committed, as on a restart), so running it again
 * would spend twice; "gone" when the turn is no longer open.
 */
async function claimTurn(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
	seq: number,
	promptSha256: string,
): Promise<"claimed" | "repeated" | "gone"> {
	return withCanonScope(deps.db(), scope, async (tx) => {
		const [s] = await tx
			.select({
				status: canonSession.status,
				turnStartedAt: canonSession.turnStartedAt,
				turnPromptSeq: canonSession.turnPromptSeq,
			})
			.from(canonSession)
			.where(eq(canonSession.id, sessionId))
			.for("update");
		if (!s || s.status !== "open" || s.turnStartedAt === null) return "gone";
		if (s.turnPromptSeq === seq) return "repeated";
		await tx
			.update(canonSession)
			.set({
				turnPromptSeq: seq,
				turnPromptSha256: promptSha256,
				...touch(deps.clock),
			})
			.where(eq(canonSession.id, sessionId));
		return "claimed";
	});
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
				clientId: s.clientId,
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
	parts: CanonPart[] = [],
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
			parts,
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
 * only what the prompt holds. Fetch reads the command center's own data.
 * Draft writes the intake's brief, questions, memory and roster, so it
 * needs a client session on an intake. Any mode may name a session that
 * has no title yet.
 */
export function toolsFor(
	mode: CanonMode,
	session: {
		clientId: string | null;
		intakeId: string | null;
		title: string | null;
	},
): readonly CanonToolName[] {
	const naming: CanonToolName[] =
		session.title === null ? ["name_session"] : [];
	if (mode === "fetch") return ["fetch", ...naming];
	if (
		mode === "draft" &&
		session.clientId !== null &&
		session.intakeId !== null
	) {
		return [...DRAFT_TOOL_NAMES, ...naming];
	}
	return naming;
}

/** The answer to a tool this turn does not have. */
const notHere = (name: CanonToolName): ToolResult => ({
	text: `${name} is not available in this mode`,
	isError: true,
});

/** A text step is written once this much has gathered, or at the turn's end. */
export const TEXT_STEP_CHARS = 400;
/** What a step's detail keeps of a tool's result for the trace. */
const RESULT_DETAIL_CHARS = 2_000;
/** At most this many cards and tables beside one reply. */
const MAX_PARTS = 10;

const nameSessionInput = z
	.object({ title: z.string().trim().min(1).max(120) })
	.strict();

/**
 * Writes one turn's steps, in order, while the turn is still the session's:
 * a halted or swept session gets no more. Returns the step's seq, or null
 * when the turn is over.
 */
function stepWriter(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
	turn: number,
) {
	return async (step: {
		kind: CanonStepKind;
		label: string;
		detail: Record<string, unknown>;
		startedAt?: Date;
	}): Promise<number | null> =>
		withCanonScope(deps.db(), scope, async (tx) => {
			const [s] = await tx
				.select({
					status: canonSession.status,
					turnStartedAt: canonSession.turnStartedAt,
				})
				.from(canonSession)
				.where(eq(canonSession.id, sessionId))
				.for("update");
			if (!s || s.status !== "open" || s.turnStartedAt === null) return null;
			const [last] = await tx
				.select({ seq: max(canonStep.seq) })
				.from(canonStep)
				.where(eq(canonStep.canonSessionId, sessionId));
			const seq = (last?.seq ?? 0) + 1;
			const now = deps.clock.now();
			await tx.insert(canonStep).values({
				id: deps.ids.next(),
				canonSessionId: sessionId,
				clientId: scopeClientId(scope),
				turn,
				seq,
				kind: step.kind,
				label: step.label.slice(0, 80),
				detail: step.detail,
				startedAt: step.startedAt ?? now,
				endedAt: now,
				tokensIn: null,
				tokensOut: null,
				createdAt: now,
			});
			return seq;
		});
}

/** Names the session if it still has no title; never one the operator named. */
async function nameSession(
	deps: CanonDeps,
	scope: CanonScope,
	sessionId: string,
	raw: unknown,
): Promise<ToolResult> {
	const parsed = nameSessionInput.safeParse(raw);
	if (!parsed.success) {
		return { text: "Give a title of 1 to 120 characters.", isError: true };
	}
	return withCanonScope(deps.db(), scope, async (tx) => {
		const named = await tx
			.update(canonSession)
			.set({
				title: parsed.data.title,
				titleSetBy: "canon",
				...touch(deps.clock),
			})
			.where(
				and(
					eq(canonSession.id, sessionId),
					eq(canonSession.status, "open"),
					isNull(canonSession.title),
				),
			)
			.returning({
				engagementId: canonSession.engagementId,
				clientId: canonSession.clientId,
			});
		const [row] = named;
		if (!row)
			return { text: "The session already has a title.", isError: true };
		await logActivity(tx, deps, {
			actorKind: "canon",
			actorCanonSessionId: sessionId,
			action: "canon_session.renamed",
			entityType: "canon_session",
			entityId: sessionId,
			engagementId: row.engagementId,
			clientId: row.clientId,
			requestId: deps.ids.next(),
			// The title is client text: never in the log.
			payload: { sessionId, hadTitle: false },
		});
		return { text: "Named." };
	});
}

/**
 * Runs one turn of the session, if it is open and mid-turn in this scope;
 * otherwise "skipped". It claims the turn before the model runs, so a turn
 * is run once: a turn a run already claimed is "repeated", never run again. A citation that names no passage of this turn's
 * knowledge, or misquotes one, fails the turn: no reply is stored. Steps
 * are written as the turn runs, for the operator to watch.
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
	const writeStep = stepWriter(deps, scope, sessionId, turn.turn.seq);
	let pendingText = "";
	const flushText = async () => {
		if (pendingText === "") return;
		const text = pendingText;
		pendingText = "";
		await writeStep({ kind: "text", label: "Writing", detail: { text } });
	};
	try {
		const files = await readFiles(deps.blobs, turn.files, log);
		const built = buildCanonPrompt({
			mode: turn.turn.mode,
			scope: scope.kind,
			titled: turn.session.title !== null,
			identityMd: turn.identityMd,
			files,
			memory: turn.memory,
			messages: turn.messages,
		});
		promptSha256 = built.sha256;
		const claim = await claimTurn(
			deps,
			scope,
			sessionId,
			turn.turn.seq,
			built.sha256,
		);
		if (claim === "gone") return { outcome: "skipped", promptSha256 };
		if (claim === "repeated") {
			log.warn(
				{ promptSha256, seq: turn.turn.seq },
				"canon turn already ran once; not running it again",
			);
			return { outcome: "repeated", promptSha256 };
		}
		const tools = toolsFor(turn.turn.mode, turn.session);
		const clientId = scopeClientId(scope);
		const { intakeId, engagementId } = turn.session;
		const draft =
			clientId !== null && intakeId !== null && engagementId !== null
				? canonTools({
						db: deps.db,
						clock: deps.clock,
						ids: deps.ids,
						clientId,
						session: { id: turn.session.id, intakeId, engagementId },
						chunkIds: new Set(built.chunks.map((c) => c.chunkId)),
						requestId: deps.ids.next(),
					})
				: null;
		const parts: CanonPart[] = [];
		const dispatchTool = async (
			name: CanonToolName,
			input: unknown,
		): Promise<ToolResult> => {
			if (!tools.includes(name)) return notHere(name);
			if (name === "fetch") return fetchData(deps.db(), scope, input);
			if (name === "name_session") {
				return nameSession(deps, scope, sessionId, input);
			}
			return draft ? draft(name, input) : notHere(name);
		};
		const callTool = async (
			name: CanonToolName,
			input: unknown,
		): Promise<ToolResult> => {
			await flushText();
			const startedAt = deps.clock.now();
			const callSeq = await writeStep({
				kind: "tool_call",
				label: `Calling ${name}`,
				detail: { tool: name, input: input ?? null },
			});
			const result = await dispatchTool(name, input);
			await writeStep({
				kind: "tool_result",
				label: result.isError ? `${name} refused` : `${name} answered`,
				detail: {
					tool: name,
					callSeq,
					isError: result.isError === true,
					text: result.text.slice(0, RESULT_DETAIL_CHARS),
				},
				startedAt,
			});
			if (!result.isError && result.parts) {
				parts.push(...result.parts.slice(0, MAX_PARTS - parts.length));
			}
			return result;
		};
		for await (const event of deps.model.run({
			sessionId,
			model: turn.session.model,
			prompt: built.prompt,
			tools,
			callTool,
			signal: abort.signal,
		})) {
			if (event.kind === "usage") {
				if (await applyCanonUsage(deps, scope, sessionId, event.split)) {
					abort.abort();
					log.info({ promptSha256 }, "canon turn halted at the hard ceiling");
					return { outcome: "halted", promptSha256 };
				}
			} else if (event.kind === "text") {
				pendingText += event.text;
				if (pendingText.length >= TEXT_STEP_CHARS) await flushText();
			} else if (event.kind === "reasoning") {
				await flushText();
				await writeStep({
					kind: "reasoning_summary",
					label: "Thinking",
					detail: { text: event.text },
				});
			} else {
				await flushText();
				const citations = storedCitations(event.citations, built.chunks);
				const stored = await storeReply(
					deps,
					scope,
					sessionId,
					turn.turn.mode,
					event.text,
					citations,
					parts,
				);
				abort.abort();
				log.info({ promptSha256, stored }, "canon turn replied");
				return { outcome: stored ? "replied" : "skipped", promptSha256 };
			}
		}
		await flushText();
		await clearTurn(deps, scope, sessionId);
		log.info({ promptSha256 }, "canon turn ended without a reply");
		return { outcome: "ended", promptSha256 };
	} catch (err) {
		abort.abort();
		const message = err instanceof Error ? err.message : String(err);
		log.error({ err: message, promptSha256 }, "canon turn failed");
		await writeStep({
			kind: "error",
			label: "The turn failed",
			detail: { message: message.slice(0, RESULT_DETAIL_CHARS) },
		}).catch(() => null);
		await clearTurn(deps, scope, sessionId);
		return { outcome: "failed", promptSha256 };
	}
}
