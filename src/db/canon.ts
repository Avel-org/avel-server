import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Clock } from "../lib/clock";
import {
	type ClientId,
	clientIdOfClient,
	clientIdOfIntake,
	clientIdsOfIntakes,
} from "./client-id";
import { canonQuestion, canonSession, client } from "./schema";
import {
	type CanonScope,
	type Executor,
	withCanonScope,
	withClientScope,
} from "./tx";

/**
 * The intake's open Canon questions, oldest first. An Intake with any cannot
 * be approved.
 *
 * It scopes itself. canon_question is under row-level security, and an
 * unscoped read as avel_app returns no rows, which would read as "no open
 * questions" and let approval through. A clientId that is not the intake's
 * client would do the same, so that refuses too.
 */
export function openCanonQuestions(
	db: Executor,
	clientId: ClientId,
	intakeId: string,
): Promise<{ id: string; header: string }[]> {
	return withClientScope(db, clientId, async (tx) => {
		const owner = await clientIdOfIntake(tx, intakeId);
		if (owner !== clientId) {
			throw new Error(
				`openCanonQuestions: intake ${intakeId} is not this client's`,
			);
		}
		return tx
			.select({ id: canonQuestion.id, header: canonQuestion.header })
			.from(canonQuestion)
			.where(
				and(
					eq(canonQuestion.intakeId, intakeId),
					eq(canonQuestion.status, "open"),
				),
			)
			.orderBy(asc(canonQuestion.createdAt), asc(canonQuestion.id));
	});
}

/**
 * Each intake's open Canon session, if it has one, for the intake wire's
 * openCanonSessionId. canon_session is under row-level security, so this
 * reads it once per client, each read in that client's own scope; a page of
 * intakes spans few clients. An intake with no open session is absent.
 */
export async function openCanonSessionIds(
	db: Executor,
	intakeIds: readonly string[],
): Promise<Map<string, string>> {
	const owners = await clientIdsOfIntakes(db, intakeIds);
	const byClient = new Map<ClientId, string[]>();
	for (const [intakeId, clientId] of owners) {
		byClient.set(clientId, [...(byClient.get(clientId) ?? []), intakeId]);
	}
	const open = new Map<string, string>();
	// Sorted, so the reads run in the same order every time.
	for (const clientId of [...byClient.keys()].sort()) {
		const rows = await withClientScope(db, clientId, (tx) =>
			tx
				.select({ intakeId: canonSession.intakeId, id: canonSession.id })
				.from(canonSession)
				.where(
					and(
						inArray(canonSession.intakeId, byClient.get(clientId) ?? []),
						eq(canonSession.status, "open"),
					),
				),
		);
		for (const r of rows) if (r.intakeId) open.set(r.intakeId, r.id);
	}
	return open;
}

/**
 * Every scope a Canon session can live in, in a stable order: the open
 * scope first, then each client by id. canon_session is under row-level
 * security, so anything that reads sessions across clients reads them
 * scope by scope.
 */
export async function canonScopes(db: Executor): Promise<CanonScope[]> {
	const clients = await db
		.select({ id: client.id })
		.from(client)
		.orderBy(asc(client.id));
	const scopes: CanonScope[] = [{ kind: "open" }];
	for (const { id } of clients) {
		const clientId = await clientIdOfClient(db, id);
		if (clientId) scopes.push({ kind: "client", clientId });
	}
	return scopes;
}

/** How long a turn may run before the sweep calls it stuck. A [hypothesis]. */
export const CANON_TURN_MAX_MS = 10 * 60 * 1000;

/**
 * Ends turns that never finished: an open session whose turn started more
 * than `maxMs` ago (a crash mid-reply, a lost harness) gets its
 * turn_started_at cleared, so the operator can post again. The session
 * stays open; nothing else changes. canon_session is under row-level
 * security, so this runs once per scope (canonScopes), the open scope
 * first, then each client in id order. Returns the sessions it cleared, for the caller's log.
 * The harness tick runs it (BE-Worker); there is no activity action for it.
 */
export async function sweepStuckCanonTurns(
	db: Executor,
	clock: Clock,
	maxMs: number = CANON_TURN_MAX_MS,
): Promise<string[]> {
	const cutoff = new Date(clock.now().getTime() - maxMs);
	const cleared: string[] = [];
	for (const scope of await canonScopes(db)) {
		const rows = await withCanonScope(db, scope, (tx) =>
			tx
				.update(canonSession)
				.set({ turnStartedAt: null, updatedAt: clock.now() })
				.where(
					and(
						eq(canonSession.status, "open"),
						isNotNull(canonSession.turnStartedAt),
						lt(canonSession.turnStartedAt, cutoff),
					),
				)
				.returning({ id: canonSession.id }),
		);
		cleared.push(...rows.map((r) => r.id));
	}
	return cleared;
}
