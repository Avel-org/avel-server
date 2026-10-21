import { eq, inArray, type SQL, sql } from "drizzle-orm";
import { canonSession, client, engagement, intake } from "./schema";
import { type CanonScope, type Executor, withOpenScope } from "./tx";

declare const clientIdBrand: unique symbol;

/**
 * A client id the server read from its own rows. withClientScope takes only
 * this, so a uuid from a request body or a model does not compile as a scope.
 * The lookups below are the only code that makes one. A cast (`as ClientId`)
 * still compiles; there is none in src/, and there should never be.
 *
 * The lookups ignore soft delete: the scope is about whose rows these are,
 * and whether a deleted row may be read is the route's question.
 */
export type ClientId = string & { readonly [clientIdBrand]: true };

const brand = (id: string) => id as ClientId;

/** The client's own id, once the row is found; null when there is none. */
export async function clientIdOfClient(
	db: Executor,
	clientId: string,
): Promise<ClientId | null> {
	const [row] = await db
		.select({ id: client.id })
		.from(client)
		.where(eq(client.id, clientId));
	return row ? brand(row.id) : null;
}

/** The engagement's client; null when there is no such engagement. */
export async function clientIdOfEngagement(
	db: Executor,
	engagementId: string,
): Promise<ClientId | null> {
	const [row] = await db
		.select({ id: engagement.clientId })
		.from(engagement)
		.where(eq(engagement.id, engagementId));
	return row ? brand(row.id) : null;
}

/** The intake's client, through its engagement; null when there is no such intake. */
export async function clientIdOfIntake(
	db: Executor,
	intakeId: string,
): Promise<ClientId | null> {
	const [row] = await db
		.select({ id: engagement.clientId })
		.from(intake)
		.innerJoin(engagement, eq(engagement.id, intake.engagementId))
		.where(eq(intake.id, intakeId));
	return row ? brand(row.id) : null;
}

/** Each intake's client, for a page of intakes at once; missing intakes are absent. */
export async function clientIdsOfIntakes(
	db: Executor,
	intakeIds: readonly string[],
): Promise<Map<string, ClientId>> {
	if (intakeIds.length === 0) return new Map();
	const rows = await db
		.select({ intakeId: intake.id, clientId: engagement.clientId })
		.from(intake)
		.innerJoin(engagement, eq(engagement.id, intake.engagementId))
		.where(inArray(intake.id, [...intakeIds]));
	return new Map(rows.map((r) => [r.intakeId, brand(r.clientId)]));
}

/*
 * Canon's own tables are under row-level security, so an id alone cannot
 * be read back to its client without a scope, and the scope is what is
 * being looked for. Each lookup below calls one SECURITY DEFINER function
 * (drizzle/0040) that discloses that one fact: the id's client, or null.
 * The caller then reads the row under withClientScope, so the policy still
 * guards the row; a wrong answer here could only make the read come back
 * empty.
 */
async function definerLookup(
	db: Executor,
	fn: SQL,
	id: string,
): Promise<ClientId | null> {
	const [row] = await db.execute<{ clientId: string | null }>(
		sql`select ${fn}(${id}::uuid) as "clientId"`,
	);
	return row?.clientId ? brand(row.clientId) : null;
}

/** A Canon session's client; null when there is no such session. */
export function clientIdOfCanonSession(db: Executor, sessionId: string) {
	return definerLookup(db, sql.raw("canon_session_client_id"), sessionId);
}

/** A Canon question's client; null when there is no such question. */
export function clientIdOfCanonQuestion(db: Executor, questionId: string) {
	return definerLookup(db, sql.raw("canon_question_client_id"), questionId);
}

/** A client memory's client; null when there is no such memory. */
export function clientIdOfClientMemory(db: Executor, memoryId: string) {
	return definerLookup(db, sql.raw("client_memory_client_id"), memoryId);
}

/**
 * A Canon session's scope, or null when there is no such session. A
 * client's session is found by the lookup above; an open one has no client,
 * so it is the one an unscoped read can see (drizzle/0042), and only an
 * unscoped read sees it.
 */
export async function canonSessionScope(
	db: Executor,
	sessionId: string,
): Promise<CanonScope | null> {
	const clientId = await clientIdOfCanonSession(db, sessionId);
	if (clientId) return { kind: "client", clientId };
	const [row] = await withOpenScope(db, (tx) =>
		tx
			.select({ id: canonSession.id })
			.from(canonSession)
			.where(eq(canonSession.id, sessionId)),
	);
	return row ? { kind: "open" } : null;
}
