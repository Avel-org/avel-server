import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { AgentReportBody } from "../contract";
import { logActivity } from "../db/activity";
import {
	type ArtifactRef,
	completionReport,
	dispatch,
	type StoredEdgeMismatch,
} from "../db/schema";
import { stamp, touch } from "../db/schema/columns";
import type { Tx } from "../db/tx";
import type { AgentCaller } from "../middleware/caller";
import { ApiError } from "../middleware/errors";
import { exitCheckpoint, type FileChange } from "../rooms/checkpoint";
import { snapshotDispatch } from "../rooms/snapshot";
import { normalizeRoomPath, ToolError } from "../rooms/tools";
import { inStep, lockDispatch, lockMission, type RunnerDeps } from "./runner";

/**
 * The agent's own CompletionReport (module 8): the only way a dispatch
 * ends as complete or blocked. The agent says what it read, its blockers
 * and its rereads; the server takes everything else from the dispatch and
 * from the room, never from the agent.
 *
 * One step: lock the mission, then the dispatch (running only, else 422
 * dispatch_not_running), run the room's exit checkpoint (422
 * writes_outside_mount, and the dispatch stays running, so the agent can
 * fix its room and report again), compare what it read with what each
 * producer last wrote on the mission, then write. Logs, in this order,
 * both as the agent:
 *
 *   completion_report.filed  { dispatchId, status, filedBy: "agent" }
 *   dispatch.closed          { status, reportId }
 *
 * The close kills the token: a retry gets 401 DISPATCH_CLOSED, and the
 * runner reads the outcome itself. The harness session stops after the
 * commit; the room is kept.
 */
export async function fileAgentReport(
	deps: RunnerDeps,
	agent: AgentCaller,
	body: AgentReportBody,
	requestId: string,
): Promise<string> {
	const read = normalizedReads(body.artifactsRead);
	const missionId = agent.dispatch.missionId;
	// A firm dispatch has no mission; no firm family may report yet.
	if (!missionId) {
		throw new ApiError("AGENT_NOT_PERMITTED", "A report belongs to a mission");
	}
	return inStep(deps, async (step) => {
		const { tx } = step;
		const m = await lockMission(tx, missionId);
		const d = await lockDispatch(tx, agent.dispatch.id);
		if (!m || !d) throw new Error(`dispatch ${agent.dispatch.id} vanished`);
		const at = { dispatchId: d.id, missionId: m.id };
		if (d.status !== "running") {
			throw new ApiError(
				"PRECONDITION_FAILED",
				`A ${d.status} dispatch takes no report`,
				{ details: { reason: "dispatch_not_running", ...at } },
			);
		}
		const room = await deps.rooms.get(d.id);
		if (!room) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				"The dispatch has no room to check",
				{ details: { reason: "room_unavailable", ...at } },
			);
		}
		const changes = await exitCheckpoint({ ...room, dispatchId: d.id });
		// The room as the dispatch commit the gate integrates (module 9), dated
		// with the same instant the dispatch closes at.
		const closedAt = deps.clock.now();
		const resultCommitSha = await snapshotDispatch(
			room,
			room.commit,
			d.id,
			closedAt.toISOString(),
		);

		// A running dispatch froze these at start (CHECK).
		const { agentVersionSha256, skillsSha256, model } = d;
		if (
			agentVersionSha256 === null ||
			skillsSha256 === null ||
			model === null
		) {
			throw new Error(`running dispatch ${d.id} froze nothing`);
		}
		const reportId = deps.ids.next();
		await tx.insert(completionReport).values({
			id: reportId,
			rosterEntryId: d.rosterEntryId,
			missionId: d.missionId,
			dispatchId: d.id,
			status: body.status,
			haltReason: null,
			softCeilingCrossed: d.softCeilingCrossed,
			actualTokens: d.tokensUsed,
			agentVersionSha256,
			skillsSha256,
			versionSource: "recorded",
			model,
			artifactsRead: read,
			artifactsWritten: await artifactsWritten(room.root, changes),
			filesTouched: changes.length,
			fileTypesTouched: fileTypes(changes),
			rereads: body.rereads,
			blockers: body.blockers.map((b) => ({
				description: b.description,
				workaround: b.workaround,
				provisioning_gap: b.provisioningGap,
			})),
			edgeMismatches: await edgeMismatches(tx, m.id, d.id, read),
			filedBy: "agent",
			resultCommitSha,
			...stamp(deps.clock),
		});
		await tx
			.update(dispatch)
			.set({
				status: body.status,
				closedAt,
				...touch(deps.clock),
			})
			.where(eq(dispatch.id, d.id));

		const actor = {
			actorKind: "agent" as const,
			actorRosterEntryId: d.rosterEntryId,
		};
		const scope = { missionId: m.id, engagementId: m.engagementId };
		await logActivity(tx, deps, {
			...actor,
			action: "completion_report.filed",
			entityType: "completion_report",
			entityId: reportId,
			...scope,
			requestId,
			payload: { dispatchId: d.id, status: body.status, filedBy: "agent" },
		});
		await logActivity(tx, deps, {
			...actor,
			action: "dispatch.closed",
			entityType: "dispatch",
			entityId: d.id,
			...scope,
			requestId,
			payload: { status: body.status, reportId },
		});
		step.stops.push(d.id);
		return reportId;
	});
}

/** artifactsRead with each path normalized as the file tools would; 400 on a bad or repeated path. */
function normalizedReads(refs: readonly ArtifactRef[]): ArtifactRef[] {
	const issues: Array<{ path: Array<string | number>; message: string }> = [];
	const seen = new Set<string>();
	const out = refs.map((r, i) => {
		let p = "";
		try {
			p = normalizeRoomPath(r.path);
		} catch (err) {
			if (!(err instanceof ToolError)) throw err;
			issues.push({
				path: ["artifactsRead", i, "path"],
				message: err.message,
			});
			return { path: r.path, sha256: r.sha256 };
		}
		if (p === "" || seen.has(p)) {
			issues.push({
				path: ["artifactsRead", i, "path"],
				message:
					p === "" ? "The room root is not a file" : `${p} is listed twice`,
			});
		}
		seen.add(p);
		return { path: p, sha256: r.sha256 };
	});
	if (issues.length > 0) {
		throw new ApiError(
			"VALIDATION_FAILED",
			"The report does not fit the room",
			{
				details: { body: issues },
			},
		);
	}
	return out;
}

const sha256 = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");

/**
 * What the agent wrote: every added, modified or renamed-to path, with the
 * SHA-256 of its bytes in the room, in the changes' order (by path). A link is hashed as its
 * target text, as git stores it, and never followed. A deleted path has no
 * bytes, so it is not listed.
 */
export async function artifactsWritten(
	root: string,
	changes: readonly FileChange[],
): Promise<ArtifactRef[]> {
	const written: ArtifactRef[] = [];
	for (const c of changes) {
		if (c.kind === "deleted") continue;
		const file = path.join(root, ...c.path.split("/"));
		const bytes = (await lstat(file)).isSymbolicLink()
			? await readlink(file)
			: await readFile(file);
		written.push({ path: c.path, sha256: sha256(bytes) });
	}
	return written;
}

/**
 * The extensions of every changed path, a rename's old path and deleted
 * paths included: lowercase, without the dot, unique and sorted. A name
 * with no extension, or a dotfile with none after its leading dot, adds
 * nothing.
 */
export function fileTypes(changes: readonly FileChange[]): string[] {
	const types = new Set<string>();
	for (const c of changes) {
		for (const p of c.kind === "renamed" ? [c.from, c.path] : [c.path]) {
			const ext = path.posix.extname(path.posix.basename(p));
			if (ext.length > 1) types.add(ext.slice(1).toLowerCase());
		}
	}
	return [...types].sort();
}

/**
 * Each read whose producer wrote another hash: the producer is the latest
 * live report on this mission, never this dispatch's, whose
 * artifacts_written names the path. No producer, no mismatch. Recorded,
 * never refused.
 */
async function edgeMismatches(
	tx: Tx,
	missionId: string,
	dispatchId: string,
	read: readonly ArtifactRef[],
): Promise<StoredEdgeMismatch[]> {
	if (read.length === 0) return [];
	const paths = read.map((r) => r.path);
	const rows = (await tx.execute(sql`
		select distinct on (aw.path) aw.path as path, aw.sha256 as sha256, cr.dispatch_id as dispatch_id
		from completion_report cr
		cross join lateral jsonb_to_recordset(cr.artifacts_written) as aw(path text, sha256 text)
		where cr.mission_id = ${missionId}
			and cr.deleted_at is null
			and cr.dispatch_id <> ${dispatchId}
			and aw.path = any(${sql`array[${sql.join(
				paths.map((p) => sql`${p}`),
				sql`, `,
			)}]::text[]`})
		order by aw.path, cr.created_at desc, cr.id desc
	`)) as unknown as Array<{
		path: string;
		sha256: string;
		dispatch_id: string;
	}>;
	const producer = new Map(rows.map((r) => [r.path, r]));
	return read.flatMap((r) => {
		const p = producer.get(r.path);
		return p && p.sha256 !== r.sha256
			? [
					{
						path: r.path,
						read_sha256: r.sha256,
						written_sha256: p.sha256,
						producer_dispatch_id: p.dispatch_id,
					},
				]
			: [];
	});
}
