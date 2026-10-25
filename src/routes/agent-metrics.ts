import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
	type AgentMetrics,
	NOT_RECORDED_MEASURES,
} from "../contract/agent-template";
import {
	activityLog,
	completionReport,
	dispatch,
	mission,
	rosterEntry,
} from "../db/schema";
import { live } from "../db/schema/columns";
import type { Executor } from "../db/tx";
import { type GateRunPayload, resultOfRun } from "./gate";

type Origin = AgentMetrics["origin"];

/** Each mission's gate runs, oldest first, as the activity log holds them. */
async function gateRunsOf(db: Executor, missionIds: readonly string[]) {
	if (missionIds.length === 0) return new Map<string, GateRunPayload[]>();
	const rows = await db
		.select({ missionId: activityLog.missionId, payload: activityLog.payload })
		.from(activityLog)
		.where(
			and(
				eq(activityLog.action, "mission.gate_run"),
				inArray(activityLog.missionId, [...missionIds]),
			),
		)
		.orderBy(asc(activityLog.at), asc(activityLog.id));
	const out = new Map<string, GateRunPayload[]>();
	for (const r of rows) {
		if (!r.missionId) continue;
		const runs = out.get(r.missionId) ?? [];
		runs.push(r.payload as GateRunPayload);
		out.set(r.missionId, runs);
	}
	return out;
}

/** The ids of a receipt's failed test-file checkpoints, each `checkpoint:test-glob:<dispatch id>...`. */
function failedTestGlobIds(run: GateRunPayload): string[] {
	const receipt = JSON.parse(run.receipt) as {
		findings?: { id: string; kind: string; outcome?: string }[];
	};
	return (receipt.findings ?? [])
		.filter(
			(f) =>
				f.kind === "checkpoint" &&
				f.outcome === "fail" &&
				f.id.startsWith("checkpoint:test-glob:"),
		)
		.map((f) => f.id);
}

/**
 * Module 12's agent measurements for one template, over client or internal
 * missions, never both (ROSTER-V2.md). Live missions only, and only
 * dispatches whose report recorded its versions: reconstructed records are
 * for findings, not numbers. Deterministic: rows are grouped and sorted by
 * their keys, never by query order.
 */
export async function agentMetrics(
	db: Executor,
	template: { id: string; name: string },
	origin: Origin,
): Promise<AgentMetrics> {
	const rows = await db
		.select({
			dispatchId: dispatch.id,
			missionId: dispatch.missionId,
			tokensUsed: dispatch.tokensUsed,
			spendUsd: dispatch.spendUsd,
			wallClockMinutes: dispatch.wallClockMinutes,
			territory: rosterEntry.territory,
			templateRef: mission.templateRef,
			engagementId: mission.engagementId,
			reportStatus: completionReport.status,
			blockers: completionReport.blockers,
			edgeMismatches: completionReport.edgeMismatches,
		})
		.from(dispatch)
		.innerJoin(rosterEntry, eq(rosterEntry.id, dispatch.rosterEntryId))
		.innerJoin(mission, and(eq(mission.id, dispatch.missionId), live(mission)))
		.innerJoin(completionReport, eq(completionReport.dispatchId, dispatch.id))
		.where(
			and(
				eq(rosterEntry.agentTemplateId, template.id),
				eq(mission.origin, origin),
				ne(completionReport.versionSource, "reconstructed"),
			),
		)
		.orderBy(asc(dispatch.id));

	const runs = await gateRunsOf(db, [...new Set(rows.map((r) => r.missionId))]);
	const caught = new Set<string>();
	for (const [, missionRuns] of runs) {
		const latest = missionRuns.at(-1);
		if (latest) for (const id of failedTestGlobIds(latest)) caught.add(id);
	}

	const groups = new Map<
		string,
		{
			key: Omit<
				AgentMetrics["outcome"][number],
				| "dispatches"
				| "tokensUsed"
				| "spendUsd"
				| "wallClockMinutes"
				| "missionsGated"
				| "firstPassVerified"
			>;
			rows: typeof rows;
		}
	>();
	for (const r of rows) {
		const k = JSON.stringify([r.territory, r.templateRef, r.engagementId]);
		const g = groups.get(k) ?? {
			key: {
				territory: r.territory,
				templateRef: r.templateRef,
				engagementId: r.engagementId,
			},
			rows: [],
		};
		g.rows.push(r);
		groups.set(k, g);
	}

	const outcome = [...groups.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, g]) => {
			const missions = [...new Set(g.rows.map((r) => r.missionId))];
			const gated = missions.filter((m) => (runs.get(m)?.length ?? 0) > 0);
			const firstVerified = gated.filter((m) => {
				const first = runs.get(m)?.[0];
				return first !== undefined && resultOfRun(first) === "verified";
			});
			return {
				...g.key,
				dispatches: g.rows.length,
				tokensUsed: g.rows.reduce((n, r) => n + r.tokensUsed, 0),
				spendUsd: g.rows.reduce((n, r) => n + Number(r.spendUsd), 0),
				wallClockMinutes: g.rows.reduce((n, r) => n + r.wallClockMinutes, 0),
				missionsGated: gated.length,
				firstPassVerified: firstVerified.length,
			};
		});

	const ids = new Set(rows.map((r) => r.dispatchId));
	return {
		agentTemplateId: template.id,
		name: template.name,
		origin,
		discipline: {
			dispatches: rows.length,
			blockersFiled: rows.reduce((n, r) => n + r.blockers.length, 0),
			blockedReports: rows.filter((r) => r.reportStatus === "blocked").length,
			edgeMismatches: rows.reduce(
				(n, r) => n + (r.edgeMismatches?.length ?? 0),
				0,
			),
			testFileWritesCaught: [...caught].filter((id) =>
				ids.has(
					id.slice(
						"checkpoint:test-glob:".length,
						"checkpoint:test-glob:".length + 36,
					),
				),
			).length,
			notRecorded: [...NOT_RECORDED_MEASURES],
		},
		outcome,
	};
}
