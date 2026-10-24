import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { errorEnvelope, startDispatchEnvelope } from "../../src/contract";
import type { DispatchStatus } from "../../src/contract/shared/status";
import type { Wave } from "../../src/contract/shared/wave";
import { closeDb } from "../../src/db/client";
import { activityLog } from "../../src/db/schema";
import { dispatchValues, insertDispatchRow } from "../db/dispatch-fixtures";
import { seedIds } from "./agent-fixtures";
import {
	activeMission,
	type Mission,
	queued,
	row,
	start,
} from "./runner-fixtures";
import { type ApiHarness, withApi } from "./support";

/**
 * Wave order (decided 2026-10-22): a start refuses while a dispatch in an
 * earlier wave of the mission is queued or running, and warns when one is
 * blocked. The wave is set on each row directly; dispatch create's rules
 * for choosing it are in dispatches.test.ts.
 */

/** A dispatch of the mission's agent in `wave`, in `status`. */
const inWave = (
	h: ApiHarness,
	m: Mission,
	wave: Wave,
	status: DispatchStatus,
) =>
	insertDispatchRow(
		h.tx,
		m.ids,
		dispatchValues(m.agent, m.ids, status, { wave }),
	);

async function earlierWaveOpen(res: Response) {
	expect(res.status).toBe(422);
	const { error } = errorEnvelope.parse(await res.json());
	expect(error.code).toBe("PRECONDITION_FAILED");
	return error.details;
}

describe.skipIf(!process.env.DATABASE_URL)("wave order at start", () => {
	afterAll(closeDb);

	it("refuses while an earlier wave has a queued dispatch, naming the earliest open wave and its dispatches", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await activeMission(h.tx, seedIds(h.ns));
			const a1 = await inWave(h, m, "A", "queued");
			const a2 = await inWave(h, m, "A", "running");
			await inWave(h, m, "B", "queued");
			const c = await queued(h.tx, m, { wave: "C" });
			const details = await earlierWaveOpen(await start(h, c));
			expect(details).toEqual({
				reason: "earlier_wave_open",
				dispatchId: c,
				missionId: m.missionId,
				wave: "A",
				dispatchIds: [a1, a2],
			});
			expect(await row(h.tx, c)).toMatchObject({
				status: "queued",
				startedAt: null,
				tokenSha256: null,
			});
			expect(
				await h.tx
					.select()
					.from(activityLog)
					.where(eq(activityLog.entityId, c)),
			).toEqual([]);
		});
	});

	it("refuses while an earlier wave has only a running dispatch", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await activeMission(h.tx, seedIds(h.ns));
			const a = await inWave(h, m, "A", "running");
			const b = await queued(h.tx, m, { wave: "B" });
			expect(await earlierWaveOpen(await start(h, b))).toMatchObject({
				reason: "earlier_wave_open",
				wave: "A",
				dispatchIds: [a],
			});
		});
	});

	it("starts past a blocked dispatch in an earlier wave, and warns with it on the response and the log", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await activeMission(h.tx, seedIds(h.ns));
			const a = await inWave(h, m, "A", "blocked");
			const b = await inWave(h, m, "B", "blocked");
			const c = await queued(h.tx, m, { wave: "C" });
			const res = await start(h, c);
			expect(res.status).toBe(200);
			const body = startDispatchEnvelope.parse(await res.json());
			expect(body.data).toMatchObject({ id: c, wave: "C", status: "running" });
			expect(body.meta).toEqual({ earlierWaveBlocked: [a, b] });
			const [log] = await h.logRows(c);
			expect(log?.payload).toMatchObject({ earlierWaveBlocked: [a, b] });
		});
	});

	it("does not wait on closed earlier work, its own wave, or a later wave", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const m = await activeMission(h.tx, seedIds(h.ns));
			for (const status of ["complete", "halted", "failed"] as const) {
				await inWave(h, m, "A", status);
			}
			await inWave(h, m, "B", "running");
			await inWave(h, m, "B", "queued");
			await inWave(h, m, "C", "running");
			await inWave(h, m, "D", "queued");
			const b = await queued(h.tx, m, { wave: "B" });
			const res = await start(h, b);
			expect(res.status).toBe(200);
			expect(startDispatchEnvelope.parse(await res.json()).meta).toEqual({
				earlierWaveBlocked: [],
			});
		});
	});

	it("never waits on another mission's earlier wave", async () => {
		await withApi(async (h) => {
			await h.signIn();
			const ids = seedIds(h.ns);
			const other = await activeMission(h.tx, ids);
			await inWave(h, other, "A", "queued");
			const m = await activeMission(h.tx, ids);
			const b = await queued(h.tx, m, { wave: "B" });
			expect((await start(h, b)).status).toBe(200);
		});
	});
});
