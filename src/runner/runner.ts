import { and, asc, eq, max, sql } from "drizzle-orm";
import {
	type HaltReason,
	type MissionStatus,
	resolveWritablePaths,
} from "../contract";
import { type Brief, briefSchema } from "../contract/intake";
import { type ActivityEntry, logActivity } from "../db/activity";
import { type DispatchRow, missionSpentUsd } from "../db/dispatch";
import { currentIdentity } from "../db/identity";
import {
	agentTemplate,
	completionReport,
	dispatch,
	dispatchStep,
	mission,
	rosterEntry,
} from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { type RunnableCheck, runnableChecks } from "../gateways/check-runner";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { uncheckedIssues } from "../lib/plan-check";
import type { TokenSplit } from "../lib/prices";
import { priceFor } from "../lib/prices";
import { identitySupported } from "../lib/roles";
import { DISPATCH_TOKEN_PREFIX, mintToken, sha256Hex } from "../lib/tokens";
import { ApiError, type ApiErrorOptions } from "../middleware/errors";
import {
	type Room,
	type RoomProvider,
	RoomUnavailable,
} from "../rooms/provider";
import { readSet } from "../rooms/read-set";
import type { RoomSourceResolver } from "../rooms/sources";
import { briefSha256, renderBrief } from "./brief";
import {
	addUsage,
	type PriceBook,
	spendCeilingReached,
	tableFor,
	wallClockSpent,
} from "./budget";
import type { Harness, HarnessSession, HarnessStep } from "./harness";
import { missionRoomSource, missionSourceMd } from "./room-source";
import { dispatchSkills, skillsSha256 } from "./skills";
import { startCommit } from "./start-commit";

/**
 * The runner core (module 6, step 6; SANDBOX.md, The runner enforces
 * budget). It starts dispatches, counts what the harness reports, halts at
 * the ceilings and the wall clock, and files the report for every halted
 * or failed dispatch as the system actor.
 *
 * Every step runs in one transaction that locks the mission, then the
 * dispatch, in that order everywhere, so two steps on one mission never
 * deadlock. The harness is told to stop only after that transaction
 * commits.
 *
 * The server ticks sweep() and tick() in its own process when the real
 * harness is on (src/runner/loop.ts, src/runner/wiring.ts). They hold no
 * timers; the caller passes the clock.
 */

export type RunnerDeps = {
	db: () => Executor;
	clock: Clock;
	ids: IdGenerator;
	harness: Harness;
	prices: PriceBook;
	rooms: RoomProvider;
	roomSources: RoomSourceResolver;
};

type Actor = Pick<
	ActivityEntry,
	"actorKind" | "actorUserId" | "actorRosterEntryId"
>;

/** Who did it, for the activity rows: the operator's request, or a runner step. */
export type Acting = { actor: Actor; requestId: string };

const SYSTEM: Actor = { actorKind: "system" };

/** The runner as actor, under a fresh run id for the activity rows. */
function system(deps: RunnerDeps): Acting {
	return { actor: SYSTEM, requestId: deps.ids.next() };
}

/** The mission fields the runner reads, locked by whoever read them. */
export type LockedMission = {
	id: string;
	status: MissionStatus;
	engagementId: string | null;
	spendCeilingUsd: string | null;
	/** The plan, read for requirement_unchecked at start. */
	brief: unknown;
};

/**
 * One step's transaction, the sessions to stop once it commits, and what
 * to undo outside the database if it rolls back (a room opened, a session
 * started).
 */
export type Step = {
	tx: Tx;
	stops: string[];
	onRollback: Array<() => Promise<void>>;
};

/**
 * Runs `fn` in one transaction, then stops the sessions it closed. When
 * the transaction rolls back, every onRollback undo runs, newest first,
 * and the error is rethrown; an undo that fails does not hide it.
 */
export async function inStep<T>(
	deps: Pick<RunnerDeps, "db" | "harness">,
	fn: (step: Step) => Promise<T>,
): Promise<T> {
	const stops: string[] = [];
	const onRollback: Step["onRollback"] = [];
	let result: T;
	try {
		result = await withTx(deps.db(), (tx) => fn({ tx, stops, onRollback }));
	} catch (err) {
		for (const undo of onRollback.reverse()) {
			await undo().catch(() => {});
		}
		throw err;
	}
	for (const id of stops) await deps.harness.stop(id);
	return result;
}

/** The mission, locked FOR UPDATE, whether or not it is live: the runner acts on evidence. */
export async function lockMission(
	tx: Tx,
	id: string,
): Promise<LockedMission | null> {
	const [m] = await tx
		.select({
			id: mission.id,
			status: mission.status,
			engagementId: mission.engagementId,
			spendCeilingUsd: mission.spendCeilingUsd,
			brief: mission.brief,
		})
		.from(mission)
		.where(eq(mission.id, id))
		.for("update");
	return m ?? null;
}

/** The dispatch, locked FOR UPDATE. Lock its mission first. */
export async function lockDispatch(
	tx: Tx,
	id: string,
): Promise<DispatchRow | null> {
	const [d] = await tx
		.select()
		.from(dispatch)
		.where(eq(dispatch.id, id))
		.for("update");
	return d ?? null;
}

/** The mission a dispatch belongs to, read without a lock, so the mission can be locked first. */
export async function missionOf(
	db: Executor,
	dispatchId: string,
): Promise<string | null> {
	const [d] = await db
		.select({ missionId: dispatch.missionId })
		.from(dispatch)
		.where(eq(dispatch.id, dispatchId));
	return d?.missionId ?? null;
}

function refuse(
	message: string,
	options: ApiErrorOptions<"PRECONDITION_FAILED">,
): ApiError {
	return new ApiError("PRECONDITION_FAILED", message, options);
}

/**
 * Starts a queued dispatch: checks, in this order, dispatch_not_queued,
 * mission_not_active, roster_entry_inactive, agent_identity_missing,
 * requirement_unchecked (a dispatch queued before step 9's rule), model_price_unknown, spend_ceiling_reached and harness_unavailable,
 * refusing with the first. Then freezes the identity version, both hashes,
 * the brief and its hash, the harness version, the model and the price version, mints the
 * token, stores only its hash, and hands the token to the harness, never
 * to a response or a log. A dispatch with no briefRef freezes no brief.
 *
 * The caller has locked `m`. The harness is started last, inside the
 * transaction, so a harness that refuses rolls the start back.
 */
export async function startDispatch(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	dispatchId: string,
	by: Acting,
): Promise<void> {
	const { tx } = step;
	const d = await lockDispatch(tx, dispatchId);
	if (!d || d.missionId !== m.id) {
		throw new Error(`dispatch ${dispatchId} is not on mission ${m.id}`);
	}
	const at = { dispatchId: d.id, missionId: m.id };
	if (d.status !== "queued") {
		throw refuse(`A ${d.status} dispatch cannot start`, {
			details: { reason: "dispatch_not_queued", ...at },
		});
	}
	if (m.status !== "active") {
		throw refuse(`A ${m.status} mission runs no dispatches`, {
			details: { reason: "mission_not_active", ...at },
		});
	}

	const [entry] = await tx
		.select({
			id: rosterEntry.id,
			active: rosterEntry.active,
			writablePaths: rosterEntry.writablePaths,
			templateId: agentTemplate.id,
			roles: agentTemplate.roles,
			templatePaths: agentTemplate.writablePaths,
		})
		.from(rosterEntry)
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.where(and(eq(rosterEntry.id, d.rosterEntryId), live(rosterEntry)));
	const entryAt = { ...at, rosterEntryIds: [d.rosterEntryId] };
	if (!entry?.active) {
		throw refuse("The roster entry is inactive", {
			details: { reason: "roster_entry_inactive", ...entryAt },
		});
	}
	// The entry's own template's current version, looked up by the
	// template: this is what ties the dispatch to its template, since the
	// version column has no FK to it.
	const version = identitySupported(entry.roles)
		? await currentIdentity(tx, entry.templateId)
		: null;
	if (!version) {
		throw refuse("The agent has no identity to run with", {
			details: { reason: "agent_identity_missing", ...entryAt },
		});
	}
	const unchecked = d.briefRef ? uncheckedIssues(m.brief, d.briefRef) : [];
	if (unchecked.length > 0) {
		throw refuse(
			"A requirement this dispatch is for has no check outside the agent",
			{
				details: { reason: "requirement_unchecked", ...at, issues: unchecked },
			},
		);
	}

	const model = deps.harness.model;
	const table = tableFor(deps.prices, deps.prices.current);
	if (!table || !priceFor(model, table)) {
		throw refuse(`No price for ${model}`, {
			details: { reason: "model_price_unknown", ...at, model },
		});
	}
	if (spendCeilingReached(await missionSpentUsd(tx, m.id), m.spendCeilingUsd)) {
		throw refuse("The mission has reached its spend ceiling", {
			details: { reason: "spend_ceiling_reached", ...at },
		});
	}

	const { room, startDispatchIds } = await openRoom(step, deps, m, d.id, {
		writablePaths: entry.writablePaths,
		templatePaths: entry.templatePaths,
	});

	const skillSet = await dispatchSkills(tx, m.id, entry.roles);
	const skills = skillsSha256(skillSet);
	// Parsed once, for the brief and for the checks run_checks may run.
	const plan = d.briefRef ? briefSchema.parse(m.brief) : null;
	const briefMd =
		d.briefRef && plan
			? await dispatchBrief(tx, m, plan, d.briefRef, room, skillSet)
			: null;
	const briefHash = briefMd === null ? null : briefSha256(briefMd);
	const token = mintToken(DISPATCH_TOKEN_PREFIX, deps.ids);
	const now = deps.clock.now();
	await tx
		.update(dispatch)
		.set({
			status: "running",
			startedAt: now,
			agentIdentityVersionId: version.id,
			agentVersionSha256: version.sha256,
			skillsSha256: skills,
			briefMd,
			briefSha256: briefHash,
			startCommitSha: room.commit,
			startDispatchIds,
			harnessVersion: deps.harness.version,
			model,
			priceVersion: deps.prices.current,
			tokenSha256: sha256Hex(token),
			...touch(deps.clock),
		})
		.where(eq(dispatch.id, d.id));
	await logActivity(tx, deps, {
		...by.actor,
		action: "dispatch.started",
		entityType: "dispatch",
		entityId: d.id,
		missionId: m.id,
		engagementId: m.engagementId,
		requestId: by.requestId,
		payload: {
			agentVersionSha256: version.sha256,
			skillsSha256: skills,
			briefSha256: briefHash,
			startCommitSha: room.commit,
			startDispatchIds,
			model,
			priceVersion: deps.prices.current,
		},
	});
	const session: HarnessSession = {
		dispatchId: d.id,
		token,
		model,
		roomRoot: room.root,
		writableGlobs: room.writableGlobs,
		roomRepoPath: room.repoPath,
		roomCommit: room.commit,
		checks: d.briefRef && plan ? dispatchChecks(plan, d.briefRef) : [],
		identityMd: version.identityMd,
		briefMd,
		skills: skillSet.map((s) => ({ slug: s.slug, contentMd: s.contentMd })),
	};
	if (!(await deps.harness.start(session))) {
		throw refuse("The harness cannot take this dispatch now", {
			details: { reason: "harness_unavailable", ...at },
		});
	}
	// A commit that fails after this must not leave a session running.
	step.onRollback.push(() => deps.harness.stop(d.id));
}

/**
 * The checks the brief's Done when lists for this dispatch that need a
 * runner: what the agent's run_checks may run, as advice (decided
 * 2026-10-22). file_exists is left to the gate.
 */
function dispatchChecks(
	plan: Brief,
	ref: NonNullable<DispatchRow["briefRef"]>,
): RunnableCheck[] {
	const ids = new Set(ref.requirementIds);
	return runnableChecks(plan.checks).filter((c) => ids.has(c.requirementId));
}

/**
 * The brief a dispatch starts with (step 9): the plan's module and
 * requirements, the module's reads at the room's commit, the client
 * source, the skills and the checks. The plan parsed at create, and only a
 * draft mission's plan can change, so a plan that no longer parses is a
 * broken invariant, not a refusal.
 */
async function dispatchBrief(
	tx: Tx,
	m: LockedMission,
	plan: Brief,
	ref: NonNullable<DispatchRow["briefRef"]>,
	room: Room,
	skills: ReadonlyArray<{ slug: string; name: string; description: string }>,
): Promise<string> {
	const module = plan.modules.find((x) => x.id === ref.moduleId);
	const reads = await readSet(room.repoPath, room.commit, module?.reads ?? []);
	return renderBrief({
		plan,
		ref,
		commit: room.commit,
		reads,
		sourceMd: await missionSourceMd(tx, m.id),
		skills,
	});
}

/**
 * The dispatch's room, from the mission's source: source_unavailable when
 * the source cannot be resolved (retrying will not help), room_unavailable
 * when it resolved but no room could be made. Once open, a rollback of
 * the start releases it.
 */
async function openRoom(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	dispatchId: string,
	paths: { writablePaths: string[] | null; templatePaths: string[] },
): Promise<{ room: Room; startDispatchIds: string[] }> {
	const at = { dispatchId, missionId: m.id };
	const found = await missionRoomSource(step.tx, m.id);
	const resolved =
		"issue" in found
			? ({ ok: false, issue: found.issue } as const)
			: await deps.roomSources.resolve(found.source);
	if (!resolved.ok) {
		throw refuse("The mission's source cannot be found", {
			details: {
				reason: "source_unavailable",
				...at,
				issues: [
					{ path: resolved.issue.path, message: resolved.issue.message },
				],
			},
		});
	}
	// The room opens on the work finished so far, not the bare base.
	const start = await startCommit(
		step.tx,
		m.id,
		resolved.repoPath,
		resolved.commit,
	);
	if (!start.ok) {
		throw refuse("Two finished dispatches changed the same paths", {
			details: {
				reason: "integration_conflict",
				...at,
				issues: start.conflicts.map((c) => ({
					path: ["integration", c.path],
					message: c.dispatchIds.join(", "),
				})),
			},
		});
	}
	let room: Room;
	try {
		room = await deps.rooms.open({
			dispatchId,
			repoPath: resolved.repoPath,
			commit: start.sha,
			writableGlobs: resolveWritablePaths(
				{ writablePaths: paths.writablePaths },
				{ writablePaths: paths.templatePaths },
			),
		});
	} catch (err) {
		if (!(err instanceof RoomUnavailable)) throw err;
		throw refuse("No room could be made for this dispatch now", {
			details: { reason: "room_unavailable", ...at },
		});
	}
	step.onRollback.push(() => deps.rooms.release(dispatchId));
	return { room, startDispatchIds: start.dispatchIds };
}

export type DispatchEnd =
	| { status: "halted"; haltReason: HaltReason }
	| { status: "failed" };

/**
 * The one way a running dispatch ends without the agent: halted or failed.
 * First counts the usage the harness reported and the runner has not read
 * (countPending), then sets the status, the halt reason and closed_at, files the system's
 * CompletionReport from the dispatch's own fields, and queues the harness
 * stop for after the commit. Logs, in this order:
 *
 *   dispatch.halted          (halted only; as `by`, the operator or the system)
 *   completion_report.filed  (system)
 *   dispatch.closed          (system)
 *
 * Closing sets closed_at, and the token dies with the status: the caller
 * middleware answers anything but running 401 DISPATCH_CLOSED. When the
 * counted usage brings an active mission to its spend ceiling, the mission
 * halts after the close (haltAtCeiling).
 */
export async function closeBySystem(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	running: DispatchRow,
	end: DispatchEnd,
	by: Acting,
): Promise<void> {
	let d = running;
	const { tx } = step;
	if (d.status !== "running") {
		throw new Error(`dispatch ${d.id} is ${d.status}, not running`);
	}
	const pending = await countPending(step, deps, m, d, by.requestId);
	d = pending.d;
	const haltReason = end.status === "halted" ? end.haltReason : null;
	await tx
		.update(dispatch)
		.set({
			status: end.status,
			haltReason,
			closedAt: deps.clock.now(),
			...touch(deps.clock),
		})
		.where(eq(dispatch.id, d.id));

	// A running dispatch froze all of these at start (CHECK).
	const { agentVersionSha256, skillsSha256: skills, model } = d;
	if (agentVersionSha256 === null || skills === null || model === null) {
		throw new Error(`running dispatch ${d.id} froze nothing`);
	}
	const reportId = deps.ids.next();
	// The report is a snapshot at the close: usage counted after it
	// (applyUsage, countAfterClose) raises the dispatch's tokensUsed, never
	// actualTokens, so tokensUsed may end above it.
	await tx.insert(completionReport).values({
		id: reportId,
		rosterEntryId: d.rosterEntryId,
		missionId: d.missionId,
		dispatchId: d.id,
		status: end.status,
		haltReason,
		softCeilingCrossed: d.softCeilingCrossed,
		actualTokens: d.tokensUsed,
		agentVersionSha256,
		skillsSha256: skills,
		versionSource: "recorded",
		model,
		artifactsRead: [],
		artifactsWritten: [],
		filesTouched: 0,
		fileTypesTouched: [],
		rereads: 0,
		blockers: [],
		edgeMismatches: [],
		filedBy: "system",
		...stamp(deps.clock),
	});

	const scope = { missionId: m.id, engagementId: m.engagementId };
	if (end.status === "halted") {
		await logActivity(tx, deps, {
			...by.actor,
			action: "dispatch.halted",
			entityType: "dispatch",
			entityId: d.id,
			...scope,
			requestId: by.requestId,
			payload: { reason: end.haltReason },
		});
	}
	await logActivity(tx, deps, {
		...SYSTEM,
		action: "completion_report.filed",
		entityType: "completion_report",
		entityId: reportId,
		...scope,
		requestId: by.requestId,
		payload: { dispatchId: d.id, status: end.status, filedBy: "system" },
	});
	await logActivity(tx, deps, {
		...SYSTEM,
		action: "dispatch.closed",
		entityType: "dispatch",
		entityId: d.id,
		...scope,
		requestId: by.requestId,
		payload: { status: end.status, reportId },
	});
	step.stops.push(d.id);
	if (pending.counted) await haltAtCeiling(step, deps, m, by.requestId);
}

/** Halts every running dispatch of the locked mission with `reason`, oldest first. */
export async function haltRunningDispatches(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	reason: HaltReason,
	by: Acting,
): Promise<void> {
	const running = await step.tx
		.select()
		.from(dispatch)
		.where(and(eq(dispatch.missionId, m.id), eq(dispatch.status, "running")))
		.orderBy(asc(dispatch.createdAt), asc(dispatch.id))
		.for("update");
	for (const d of running) {
		await closeBySystem(
			step,
			deps,
			m,
			d,
			{ status: "halted", haltReason: reason },
			by,
		);
	}
}

/**
 * Writes one usage step's counts onto the dispatch, logs the first
 * soft-ceiling crossing as the system unless `logSoft` is false (a closed
 * dispatch), and returns the row as counted. Throws when the dispatch has
 * no price table, which start refuses.
 */
async function writeUsage(
	tx: Tx,
	deps: RunnerDeps,
	m: LockedMission,
	d: DispatchRow,
	split: TokenSplit,
	requestId: string,
	logSoft = true,
): Promise<{ d: DispatchRow; hardReached: boolean }> {
	const version = d.priceVersion;
	const table = version === null ? undefined : tableFor(deps.prices, version);
	if (!table || d.model === null) {
		throw new Error(`dispatch ${d.id} has no price table ${version}`);
	}
	const next = addUsage({ ...d, model: d.model }, split, table);
	const counts = {
		tokensIn: next.tokensIn,
		tokensOut: next.tokensOut,
		cacheReadTokens: next.cacheReadTokens,
		cacheWriteTokens: next.cacheWriteTokens,
		tokensUsed: next.tokensUsed,
		spendUsd: next.spendUsd,
		softCeilingCrossed: next.softCeilingCrossed,
	};
	await tx
		.update(dispatch)
		.set({ ...counts, ...touch(deps.clock) })
		.where(eq(dispatch.id, d.id));
	if (logSoft && next.crossedSoftNow) {
		await logActivity(tx, deps, {
			...SYSTEM,
			action: "dispatch.soft_ceiling_crossed",
			entityType: "dispatch",
			entityId: d.id,
			missionId: m.id,
			engagementId: m.engagementId,
			requestId,
			payload: {
				tokenSoftCeiling: d.tokenSoftCeiling,
				tokensUsed: next.tokensUsed,
			},
		});
	}
	return { d: { ...d, ...counts }, hardReached: next.hardReached };
}

const isZeroSplit = (s: TokenSplit) =>
	s.tokensIn === 0 &&
	s.tokensOut === 0 &&
	s.cacheReadTokens === 0 &&
	s.cacheWriteTokens === 0;

/**
 * Runner H1: counts, in the closing step's transaction, the usage the
 * harness reported for a running dispatch and the runner has not read yet
 * (Harness.takeUsage): queued usage events, a message still streaming
 * and the SDK's end-of-run totals. Without it, whatever closed the
 * dispatch (a halt, a ceiling, the wall clock, the agent's report) dropped
 * those tokens, since usage counts only on a running dispatch. The halt
 * reason is the closer's; a hard ceiling crossed here only shows in the
 * counts. A first soft-ceiling crossing is logged under `requestId`, the
 * closer's. Returns the row as counted, and whether anything was.
 */
export async function countPending(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	d: DispatchRow,
	requestId: string,
): Promise<{ d: DispatchRow; counted: boolean }> {
	const split = await deps.harness.takeUsage(d.id);
	if (isZeroSplit(split)) return { d, counted: false };
	step.onRollback.push(() => deps.harness.restoreUsage(d.id, split));
	const written = await writeUsage(step.tx, deps, m, d, split, requestId);
	return { d: written.d, counted: true };
}

/**
 * Halts the mission at its spend ceiling, as the system, when it is still
 * active and its spend has reached the ceiling. Reads the mission's status
 * again, under the lock its caller holds, since an earlier step in the
 * same transaction may have halted it. Returns whether it halted it.
 */
export async function haltAtCeiling(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	requestId: string,
): Promise<boolean> {
	const [now] = await step.tx
		.select({ status: mission.status })
		.from(mission)
		.where(eq(mission.id, m.id));
	if (now?.status !== "active") return false;
	if (
		!spendCeilingReached(
			await missionSpentUsd(step.tx, m.id),
			m.spendCeilingUsd,
		)
	) {
		return false;
	}
	await haltMissionAtCeiling(
		step,
		deps,
		{ ...m, status: now.status },
		{ actor: SYSTEM, requestId },
	);
	return true;
}

/**
 * The runner halting a mission at its spend ceiling: active to halted as
 * the system, then every running dispatch halted with spend_ceiling.
 */
async function haltMissionAtCeiling(
	step: Step,
	deps: RunnerDeps,
	m: LockedMission,
	by: Acting,
): Promise<void> {
	await step.tx
		.update(mission)
		.set({ status: "halted", ...touch(deps.clock) })
		.where(eq(mission.id, m.id));
	await logActivity(step.tx, deps, {
		...by.actor,
		action: "mission.status_changed",
		entityType: "mission",
		entityId: m.id,
		missionId: m.id,
		engagementId: m.engagementId,
		requestId: by.requestId,
		payload: { from: m.status, to: "halted" },
	});
	await haltRunningDispatches(
		step,
		deps,
		{ ...m, status: "halted" },
		"spend_ceiling",
		by,
	);
}

/**
 * Locks a running dispatch with its mission. Null when it is gone or no
 * longer running, which a step then leaves alone.
 */
async function lockRunning(
	tx: Tx,
	dispatchId: string,
): Promise<{ m: LockedMission; d: DispatchRow } | null> {
	const missionId = await missionOf(tx, dispatchId);
	if (!missionId) return null;
	const m = await lockMission(tx, missionId);
	const d = await lockDispatch(tx, dispatchId);
	if (!m || !d || d.status !== "running") return null;
	return { m, d };
}

/**
 * One usage step, in one transaction: adds the tokens, reprices the split
 * at the dispatch's frozen table, records the first soft-ceiling crossing
 * once, and halts at the hard ceiling (token_hard_ceiling). When the
 * mission's spend, this step included, reaches its ceiling, the mission
 * halts and so does every running dispatch on it (spend_ceiling); this
 * dispatch keeps token_hard_ceiling when it reached both at once.
 * Returns whether the dispatch is still running.
 *
 * Usage that arrives after the dispatch closed was still spent: the tick
 * took the event off the harness's queue, and a close committed before
 * this locked the dispatch, so the close's countPending could not see it.
 * It is added to the closed dispatch's counts and spend, and so to the
 * mission's, with no soft-ceiling log and no halt of the dispatch; the
 * mission still halts at its ceiling. The report keeps what it filed at
 * the close. A dispatch that never started has no price table and counts
 * nothing.
 */
export async function applyUsage(
	deps: RunnerDeps,
	dispatchId: string,
	split: TokenSplit,
): Promise<boolean> {
	return inStep(deps, async (step) => {
		const locked = await lockRunning(step.tx, dispatchId);
		if (!locked) {
			await countAfterClose(step, deps, dispatchId, split);
			return false;
		}
		const { m } = locked;
		const by = system(deps);
		const { d, hardReached } = await writeUsage(
			step.tx,
			deps,
			m,
			locked.d,
			split,
			by.requestId,
		);
		if (hardReached) {
			await closeBySystem(
				step,
				deps,
				m,
				d,
				{ status: "halted", haltReason: "token_hard_ceiling" },
				by,
			);
		}
		const ceilingReached = await haltAtCeiling(step, deps, m, by.requestId);
		return !hardReached && !ceilingReached;
	});
}

/** applyUsage's late count on a closed dispatch; nothing for one never started or gone. */
async function countAfterClose(
	step: Step,
	deps: RunnerDeps,
	dispatchId: string,
	split: TokenSplit,
): Promise<void> {
	const missionId = await missionOf(step.tx, dispatchId);
	if (!missionId) return;
	const m = await lockMission(step.tx, missionId);
	const d = await lockDispatch(step.tx, dispatchId);
	if (!m || !d || d.status === "queued" || d.closedAt === null) return;
	const requestId = deps.ids.next();
	await writeUsage(step.tx, deps, m, d, split, requestId, false);
	await haltAtCeiling(step, deps, m, requestId);
}

/** Closes one running dispatch as `end`, as the system, in its own step. */
export async function closeRunning(
	deps: RunnerDeps,
	dispatchId: string,
	end: DispatchEnd,
): Promise<boolean> {
	return inStep(deps, async (step) => {
		const locked = await lockRunning(step.tx, dispatchId);
		if (!locked) return false;
		await closeBySystem(step, deps, locked.m, locked.d, end, system(deps));
		return true;
	});
}

export type SweepResult = { halted: string[]; failed: string[] };

/**
 * Run on the runner's startup and at the top of every tick. Every running
 * dispatch past its wall clock (now >= started_at + wall_clock_minutes) is
 * halted wall_clock. One the harness has no session for, as after a
 * restart, is halted wall_clock when past its limit and otherwise failed:
 * its work stopped with nothing left to report, and failed is how the
 * runner records that (decided 2026-10-13).
 */
export async function sweep(deps: RunnerDeps): Promise<SweepResult> {
	const now = deps.clock.now();
	const running = await deps
		.db()
		.select({
			id: dispatch.id,
			startedAt: dispatch.startedAt,
			wallClockMinutes: dispatch.wallClockMinutes,
		})
		.from(dispatch)
		.where(eq(dispatch.status, "running"))
		.orderBy(asc(dispatch.startedAt), asc(dispatch.id));
	const result: SweepResult = { halted: [], failed: [] };
	for (const r of running) {
		if (r.startedAt === null) throw new Error(`running ${r.id} never started`);
		if (wallClockSpent(r.startedAt, r.wallClockMinutes, now)) {
			const end = { status: "halted", haltReason: "wall_clock" } as const;
			if (await closeRunning(deps, r.id, end)) result.halted.push(r.id);
		} else if (!(await deps.harness.has(r.id))) {
			if (await closeRunning(deps, r.id, { status: "failed" })) {
				result.failed.push(r.id);
			}
		}
	}
	return result;
}

/**
 * Writes one step of a dispatch's run, as the next seq, at the clock's now.
 * A tool_result names the seq of its tool_call by the SDK's toolUseId, so
 * the trace can pair them. Steps never touch the budget.
 */
export async function writeDispatchStep(
	deps: RunnerDeps,
	dispatchId: string,
	step: HarnessStep,
): Promise<number> {
	return withTx(deps.db(), async (tx) => {
		// One writer per dispatch: the runner's tick, and the seq follows.
		await tx
			.select({ id: dispatch.id })
			.from(dispatch)
			.where(eq(dispatch.id, dispatchId))
			.for("update");
		const [last] = await tx
			.select({ seq: max(dispatchStep.seq) })
			.from(dispatchStep)
			.where(eq(dispatchStep.dispatchId, dispatchId));
		const seq = (last?.seq ?? 0) + 1;
		const detail = { ...step.detail };
		const toolUseId = detail.toolUseId;
		if (step.kind === "tool_result" && typeof toolUseId === "string") {
			const [call] = await tx
				.select({ seq: dispatchStep.seq })
				.from(dispatchStep)
				.where(
					and(
						eq(dispatchStep.dispatchId, dispatchId),
						eq(dispatchStep.kind, "tool_call"),
						sql`${dispatchStep.detail}->>'toolUseId' = ${toolUseId}`,
					),
				)
				.orderBy(asc(dispatchStep.seq))
				.limit(1);
			detail.callSeq = call?.seq ?? null;
		}
		const now = deps.clock.now();
		await tx.insert(dispatchStep).values({
			id: deps.ids.next(),
			dispatchId,
			seq,
			kind: step.kind,
			label: step.label.slice(0, 80),
			detail,
			startedAt: now,
			endedAt: now,
			tokensIn: null,
			tokensOut: null,
			createdAt: now,
		});
		return seq;
	});
}

/**
 * One runner tick at the clock's now: the sweep, then every running
 * dispatch's harness events, each in its own step. A step event is written
 * for the trace; a usage event is counted; fail closes the dispatch as failed. complete and blocked are the
 * agent's to report with its token (step 8), so the runner reads them and
 * does nothing, and the dispatch runs on until its report or its wall clock.
 */
export async function tick(deps: RunnerDeps): Promise<SweepResult> {
	const swept = await sweep(deps);
	const running = await deps
		.db()
		.select({ id: dispatch.id })
		.from(dispatch)
		.where(eq(dispatch.status, "running"))
		.orderBy(asc(dispatch.startedAt), asc(dispatch.id));
	for (const { id } of running) {
		for (;;) {
			const event = await deps.harness.next(id);
			if (event === null) break;
			if (event.kind === "step") {
				await writeDispatchStep(deps, id, event.step);
			} else if (event.kind === "usage") {
				if (!(await applyUsage(deps, id, event.split))) break;
			} else if (event.kind === "fail") {
				await closeRunning(deps, id, { status: "failed" });
				break;
			} else {
				// complete or blocked: the agent's own report (POST
				// /api/agent/report) is the only close path for those, so
				// the runner closes nothing here.
				break;
			}
		}
	}
	return swept;
}
