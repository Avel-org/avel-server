import { expect } from "vitest";
import {
	gateJob as gateJobSchema,
	gateRun as gateRunSchema,
	successEnvelope,
} from "../../src/contract";
import type { CheckRunner } from "../../src/gateways/check-runner";
import type { RoomSourceResolver } from "../../src/rooms/sources";
import { type GateJobDeps, gateJobTick } from "../../src/runner/gate-job";
import { type ApiHarness, clock } from "./support";

/** What the gate tick runs with, per harness: set by jobDeps. */
const jobs = new WeakMap<ApiHarness, GateJobDeps>();

/**
 * The gate tick's deps for this harness, remembered for drain and gateToEnd.
 * Its ids are apart from the app's and the fixtures' (a000).
 */
export function jobDeps(
	h: ApiHarness,
	roomSources: RoomSourceResolver,
	checkRunner: CheckRunner | null = null,
	tickClock: GateJobDeps["clock"] = clock,
): GateJobDeps {
	let n = 0;
	const deps: GateJobDeps = {
		db: () => h.tx,
		clock: tickClock,
		ids: {
			next: () =>
				`${h.ns}-0000-4000-b000-${(++n).toString(16).padStart(12, "0")}`,
		},
		roomSources,
		checkRunner,
	};
	jobs.set(h, deps);
	return deps;
}

/** Runs the gate tick until no job is queued. */
export async function drain(h: ApiHarness) {
	const deps = jobs.get(h);
	if (!deps) throw new Error("no gate job deps for this harness: call jobDeps");
	for (;;) {
		const r = await gateJobTick(deps);
		if (r.jobId === null) return;
	}
}

export const postGate = (
	h: ApiHarness,
	missionId: string,
	body: unknown = {},
	key?: string,
) =>
	h.call(`/api/missions/${missionId}/gate`, {
		method: "POST",
		body,
		headers: key ? { "idempotency-key": key } : {},
	});

/**
 * POST the gate and, when it queues a job, run it to the end and answer
 * the finished run's GET (200). A refusal, a replay or an existing job is
 * the POST's own answer.
 */
export async function runGate(
	h: ApiHarness,
	missionId: string,
	body: unknown = {},
	key?: string,
): Promise<Response> {
	const res = await postGate(h, missionId, body, key);
	if (res.status !== 202) return res;
	const queued = successEnvelope(gateJobSchema).parse(await res.json()).data;
	await drain(h);
	const job = successEnvelope(gateJobSchema).parse(
		await (await h.call(`/api/gate-jobs/${queued.id}`)).json(),
	).data;
	expect(job.status, JSON.stringify(job.failure)).toBe("done");
	return h.call(`/api/missions/${missionId}/gate-runs/${job.gateRunId}`);
}

/** runGate, expecting a finished run, parsed. */
export async function gateRunOf(
	h: ApiHarness,
	missionId: string,
	body: unknown = {},
) {
	const res = await runGate(h, missionId, body);
	expect(res.status, await res.clone().text()).toBe(200);
	return successEnvelope(gateRunSchema).parse(await res.json()).data;
}
