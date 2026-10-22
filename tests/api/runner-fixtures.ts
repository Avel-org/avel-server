import { and, asc, eq } from "drizzle-orm";
import { expect } from "vitest";
import { dispatch as dispatchWire, successEnvelope } from "../../src/contract";
import type { NewDispatch } from "../../src/db/dispatch";
import {
	activityLog,
	completionReport,
	dispatch,
	intake,
	mission,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { Clock } from "../../src/lib/clock";
import type { IdGenerator } from "../../src/lib/ids";
import type { PriceBook } from "../../src/runner/budget";
import type { FakeHarness, Harness } from "../../src/runner/harness";
import type { RunnerDeps } from "../../src/runner/runner";
import {
	DISPATCH_PLAN,
	dispatchValues,
	insertDispatchRow,
} from "../db/dispatch-fixtures";
import { anySource, memoryRooms } from "../unit/room-fixtures";
import { type Seeded, seedRosteredAgent } from "./agent-fixtures";
import { type ApiHarness, clock } from "./support";

// Missions, dispatches and a priced book for the runner's API tests.
// Not collected as a test file.

export const read = successEnvelope(dispatchWire);

/** A test price version: the FakeHarness at $1 per thousand tokens of each kind. */
export const TEST_PRICE_VERSION = "test-prices";

/** A book the tests can change mid-test. */
export function pricedBook(): PriceBook & {
	tables: Record<string, PriceBook["tables"][string]>;
} {
	const perK = 1000;
	return {
		current: TEST_PRICE_VERSION,
		tables: {
			[TEST_PRICE_VERSION]: {
				"fake-harness": {
					inputPerMTok: perK,
					outputPerMTok: perK,
					cacheReadPerMTok: perK,
					cacheWritePerMTok: perK,
				},
			},
		},
	};
}

/** Runner ids under the call's namespace, in a block neither the app nor seedIds uses. */
export function runnerIds(ns: string): IdGenerator {
	let n = 0;
	return {
		next: () => {
			n += 1;
			return `${ns}-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;
		},
	};
}

/**
 * A seeded mission as the runner tests use it. engagementId is the
 * mission's own: null for an internal mission, whose seeded engagement
 * row is left unused.
 */
export type Mission = Omit<Seeded, "engagementId"> & {
	ids: IdGenerator;
	engagementId: string | null;
};
export type ClientMission = Mission & { engagementId: string };

/** The template commit activeMission's missions record. */
export const TEMPLATE_COMMIT = "a".repeat(40);

/** The client repository activeClientMission's intake reads, and its commit. */
export const CLIENT_REPO = "https://github.com/meridian-co/app";
export const CLIENT_COMMIT = "c".repeat(40);

async function activate(
	tx: Tx,
	missionId: string,
	spendCeilingUsd: string,
	set: Partial<typeof mission.$inferInsert>,
) {
	await tx
		.update(mission)
		.set({
			status: "active",
			brief: DISPATCH_PLAN,
			spendCeilingUsd,
			...set,
		})
		.where(eq(mission.id, missionId));
}

/**
 * An active internal mission (a template build by AVEL's own roster) with
 * a spend ceiling, and one model agent on its roster. Its rooms come from
 * its template pin (decided 2026-10-21, J): the source start needs.
 */
export async function activeMission(
	tx: Tx,
	ids: IdGenerator,
	spendCeilingUsd = "100.00",
): Promise<Mission & { engagementId: null }> {
	const seeded = await seedRosteredAgent(tx, ids, ["domain", "api-surface"]);
	await activate(tx, seeded.missionId, spendCeilingUsd, {
		engagementId: null,
		origin: "internal",
		templateRef: "template-booking",
		templateVersion: TEMPLATE_COMMIT,
	});
	return { ...seeded, ids, engagementId: null };
}

/**
 * An active client mission with a spend ceiling and one model agent on its
 * roster, and no template pin. Its rooms come from its one approved
 * intake's repository read, so `read` adds that intake (CLIENT_REPO at
 * CLIENT_COMMIT by default); null adds none, for a test that adds its own.
 */
export async function activeClientMission(
	h: Pick<ApiHarness, "tx" | "operatorId">,
	ids: IdGenerator,
	read: { repoUrl: string; commit: string } | null = {
		repoUrl: CLIENT_REPO,
		commit: CLIENT_COMMIT,
	},
	spendCeilingUsd = "100.00",
): Promise<ClientMission> {
	const seeded = await seedRosteredAgent(h.tx, ids, ["domain", "api-surface"]);
	await activate(h.tx, seeded.missionId, spendCeilingUsd, {});
	const m = { ...seeded, ids };
	if (read) await approvedIntake(h, m, read);
	return m;
}

/** An approved intake on the client mission, with this repository read or none. */
export async function approvedIntake(
	h: Pick<ApiHarness, "tx" | "operatorId">,
	m: ClientMission,
	read: { repoUrl: string; commit: string } | null,
	sourceMd = "# Ask",
): Promise<string> {
	const id = m.ids.next();
	await h.tx.insert(intake).values({
		id,
		engagementId: m.engagementId,
		status: "approved",
		sourceMd,
		openQuestions: [],
		approvedBy: await h.operatorId(),
		approvedAt: clock.now(),
		missionId: m.missionId,
		repoUrl: read?.repoUrl ?? null,
		repoCommitSha: read?.commit ?? null,
		repoReadAt: read ? clock.now() : null,
		...stamp(clock),
	});
	return id;
}

/** A queued dispatch of the mission's agent. */
export async function queued(
	tx: Tx,
	m: Mission,
	over: Partial<NewDispatch> = {},
): Promise<string> {
	return insertDispatchRow(
		tx,
		m.ids,
		dispatchValues(m.agent, m.ids, "queued", over),
	);
}

/** Signs in once per harness, then starts the dispatch through the route. */
export async function start(h: ApiHarness, id: string): Promise<Response> {
	return h.call(`/api/dispatches/${id}/start`, { method: "POST" });
}

/** A fresh queued dispatch, scripted and started through the route. */
export async function started(
	h: ApiHarness,
	harness: FakeHarness,
	m: Mission,
	script?: Parameters<FakeHarness["script"]>[1],
	over: Partial<NewDispatch> = {},
): Promise<{ id: string; token: string }> {
	const id = await queued(h.tx, m, over);
	if (script) harness.script(id, script);
	const res = await start(h, id);
	expect(res.status).toBe(200);
	const token = harness.tokenFor(id);
	if (!token) throw new Error(`no session for ${id}`);
	return { id, token };
}

/** One runner id generator per call namespace, so later steps never reuse an id. */
const runnerIdsByNs = new Map<string, IdGenerator>();

export function runnerDeps(
	h: Pick<ApiHarness, "tx" | "ns">,
	harness: Harness,
	prices: PriceBook,
	clock: Clock,
	rooms: Pick<RunnerDeps, "rooms" | "roomSources"> = {
		rooms: memoryRooms(),
		roomSources: anySource,
	},
): RunnerDeps {
	let ids = runnerIdsByNs.get(h.ns);
	if (!ids) {
		ids = runnerIds(h.ns);
		runnerIdsByNs.set(h.ns, ids);
	}
	return { db: () => h.tx, clock, ids, harness, prices, ...rooms };
}

/** A token split with only input tokens. */
export const tokensIn = (n: number) => ({
	tokensIn: n,
	tokensOut: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
});

export async function row(tx: Tx, id: string) {
	const [d] = await tx.select().from(dispatch).where(eq(dispatch.id, id));
	if (!d) throw new Error(`no dispatch ${id}`);
	return d;
}

export async function reportsOf(tx: Tx, id: string) {
	return tx
		.select()
		.from(completionReport)
		.where(eq(completionReport.dispatchId, id));
}

/** The activity rows about this dispatch or its report, in the order written. */
export async function lifeOf(tx: Tx, id: string) {
	const [report] = await reportsOf(tx, id);
	const rows = await tx
		.select()
		.from(activityLog)
		.where(eq(activityLog.entityId, id))
		.orderBy(asc(activityLog.id));
	const filed = report
		? await tx
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.entityId, report.id),
						eq(activityLog.action, "completion_report.filed"),
					),
				)
		: [];
	return [...rows, ...filed].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The one report the dispatch closed with, consistent with the dispatch:
 * its status, halt reason, tokens, hashes and model, filed by the system.
 */
export async function expectSystemReport(tx: Tx, id: string) {
	const d = await row(tx, id);
	const reports = await reportsOf(tx, id);
	expect(reports).toHaveLength(1);
	const [r] = reports as [(typeof reports)[number]];
	expect(r).toMatchObject({
		dispatchId: d.id,
		missionId: d.missionId,
		rosterEntryId: d.rosterEntryId,
		status: d.status,
		haltReason: d.haltReason,
		softCeilingCrossed: d.softCeilingCrossed,
		actualTokens: d.tokensUsed,
		agentVersionSha256: d.agentVersionSha256,
		skillsSha256: d.skillsSha256,
		model: d.model,
		versionSource: "recorded",
		filedBy: "system",
		createdAt: d.closedAt,
	});
	expect(d.closedAt).not.toBeNull();
	return { d, r };
}

/**
 * Every live report on these missions has its dispatch's status and halt
 * reason, and its dispatch is closed: the report and the close are written
 * together by construction (closeBySystem, fileAgentReport), checked here.
 */
export async function expectReportsMatchDispatches(
	tx: Tx,
	missionIds: readonly string[],
) {
	for (const missionId of missionIds) {
		const rows = await tx
			.select({
				reportStatus: completionReport.status,
				reportHalt: completionReport.haltReason,
				dispatchStatus: dispatch.status,
				dispatchHalt: dispatch.haltReason,
				closedAt: dispatch.closedAt,
				id: dispatch.id,
			})
			.from(completionReport)
			.innerJoin(dispatch, eq(dispatch.id, completionReport.dispatchId))
			.where(eq(completionReport.missionId, missionId));
		for (const r of rows) {
			expect([r.reportStatus, r.reportHalt], r.id).toEqual([
				r.dispatchStatus,
				r.dispatchHalt,
			]);
			expect(r.closedAt, r.id).not.toBeNull();
		}
	}
}
