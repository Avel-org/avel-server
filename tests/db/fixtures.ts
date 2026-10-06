import { getDb } from "../../src/db/client";
import { client, engagement, mission } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { type Tx, withTx } from "../../src/db/tx";
import { fixedClock } from "../../src/lib/clock";
import { type IdGenerator, sequentialIds } from "../../src/lib/ids";

export const clock = fixedClock("2026-10-05T12:00:00.000Z");

class Rollback extends Error {}

/**
 * Runs `fn` in a transaction that always rolls back, so a test leaves no rows
 * behind and tests in parallel files never see each other's data.
 */
export async function inRollback(
	fn: (tx: Tx, ids: IdGenerator) => Promise<void>,
) {
	const ids = sequentialIds();
	await withTx(getDb(), async (tx) => {
		await fn(tx, ids);
		throw new Rollback();
	}).catch((e: unknown) => {
		if (!(e instanceof Rollback)) throw e;
	});
}

/**
 * Runs `fn` in a savepoint and returns the Postgres error it raised, so one
 * refused statement does not abort the surrounding transaction.
 */
export async function refusal(
	tx: Tx,
	fn: (tx: Tx) => Promise<unknown>,
): Promise<{ code?: string; constraint_name?: string; message: string }> {
	try {
		await withTx(tx, fn);
	} catch (e) {
		const pg = (e as { cause?: unknown }).cause ?? e;
		return pg as { code?: string; constraint_name?: string; message: string };
	}
	throw new Error(
		"expected the database to refuse this statement, and it did not",
	);
}

/** A client, an engagement, and a draft mission: the parents most tables need. */
export async function seedMission(tx: Tx, ids: IdGenerator) {
	const clientId = ids.next();
	const engagementId = ids.next();
	const missionId = ids.next();
	await tx.insert(client).values({
		id: clientId,
		name: "Meridian",
		status: "active",
		...stamp(clock),
	});
	await tx.insert(engagement).values({
		id: engagementId,
		clientId,
		name: "App build",
		status: "active",
		startedAt: clock.now(),
		...stamp(clock),
	});
	await tx.insert(mission).values({
		id: missionId,
		engagementId,
		origin: "client",
		type: "full-build",
		brief: {},
		sprintN: 1,
		status: "draft",
		cut: "vertical",
		cutSource: "derived",
		repoUrl: "https://github.com/meridian-co/app",
		...stamp(clock),
	});
	return { clientId, engagementId, missionId };
}
