import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Role } from "../contract/agent-template";
import type { CompletionReport, Dispatch } from "../contract/dispatch";
import type { DispatchStatus } from "../contract/shared/status";
import type { Clock } from "../lib/clock";
import type { IdGenerator } from "../lib/ids";
import { after, toPage } from "../routes/shared";
import {
	agentIdentityVersion,
	agentTemplate,
	completionReport,
	dispatch,
	rosterEntry,
} from "./schema";
import { live, stamp } from "./schema/columns";
import type { Executor, Tx } from "./tx";

/**
 * Dispatches and their completion reports (module 6). Dispatch is evidence
 * and has no deleted_at; completion_report has one, so its reads use live().
 * A dispatch's entry and template are joined whether or not they were later
 * deleted, because the run still happened. Routes log the activity; nothing
 * here writes ActivityLog.
 */

export type DispatchRow = typeof dispatch.$inferSelect;
export type RosterEntryRow = typeof rosterEntry.$inferSelect;
export type ReportRow = typeof completionReport.$inferSelect;

/** Everything but the id and the two times, which come from ids and clock. */
export type NewDispatch = Omit<
	typeof dispatch.$inferInsert,
	"id" | "createdAt" | "updatedAt"
>;

export async function insertDispatch(
	tx: Tx,
	clock: Clock,
	ids: IdGenerator,
	values: NewDispatch,
): Promise<DispatchRow> {
	const [row] = await tx
		.insert(dispatch)
		.values({ ...values, id: ids.next(), ...stamp(clock) })
		.returning();
	return row as DispatchRow;
}

/** The template a frozen identity version belongs to, for its display ref. */
const versionTemplate = alias(agentTemplate, "version_template");

const ref = (slug: string | null, number: number | null) =>
	slug !== null && number !== null ? `${slug}@v${number}` : null;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function dispatchQuery(db: Executor) {
	return db
		.select({
			row: dispatch,
			territory: rosterEntry.territory,
			agent: {
				templateId: agentTemplate.id,
				slug: agentTemplate.slug,
				name: agentTemplate.name,
				title: agentTemplate.title,
			},
			versionSlug: versionTemplate.slug,
			versionNumber: agentIdentityVersion.number,
			reportId: completionReport.id,
		})
		.from(dispatch)
		.innerJoin(rosterEntry, eq(rosterEntry.id, dispatch.rosterEntryId))
		.innerJoin(agentTemplate, eq(agentTemplate.id, rosterEntry.agentTemplateId))
		.leftJoin(
			agentIdentityVersion,
			eq(agentIdentityVersion.id, dispatch.agentIdentityVersionId),
		)
		.leftJoin(
			versionTemplate,
			eq(versionTemplate.id, agentIdentityVersion.agentTemplateId),
		)
		.leftJoin(
			completionReport,
			and(eq(completionReport.dispatchId, dispatch.id), live(completionReport)),
		);
}

export type DispatchWireRow = Awaited<
	ReturnType<ReturnType<typeof dispatchQuery>["execute"]>
>[number];

/**
 * The contract's Dispatch, field by field. Never spread the row: a spread
 * would carry token_sha256 and idempotency_key onto the wire.
 */
export function toDispatchWire(r: DispatchWireRow): Dispatch {
	const d = r.row;
	return {
		id: d.id,
		missionId: d.missionId,
		rosterEntryId: d.rosterEntryId,
		agent: {
			templateId: r.agent.templateId,
			slug: r.agent.slug,
			name: r.agent.name,
			title: r.agent.title,
		},
		territory: r.territory,
		briefRef: d.briefRef
			? {
					moduleId: d.briefRef.moduleId,
					requirementIds: [...d.briefRef.requirementIds],
				}
			: null,
		status: d.status,
		haltReason: d.haltReason,
		estimatedTokens: d.estimatedTokens,
		tokenSoftCeiling: d.tokenSoftCeiling,
		tokenHardCeiling: d.tokenHardCeiling,
		softCeilingCrossed: d.softCeilingCrossed,
		tokensUsed: d.tokensUsed,
		tokensIn: d.tokensIn,
		tokensOut: d.tokensOut,
		cacheReadTokens: d.cacheReadTokens,
		cacheWriteTokens: d.cacheWriteTokens,
		spendUsd: Number(d.spendUsd),
		wallClockMinutes: d.wallClockMinutes,
		agentVersionSha256: d.agentVersionSha256,
		agentVersionRef: ref(r.versionSlug, r.versionNumber),
		skillsSha256: d.skillsSha256,
		briefSha256: d.briefSha256,
		startCommitSha: d.startCommitSha,
		startDispatchIds: d.startDispatchIds ? [...d.startDispatchIds] : null,
		model: d.model,
		harnessVersion: d.harnessVersion,
		reportId: r.reportId,
		startedAt: iso(d.startedAt),
		closedAt: iso(d.closedAt),
		createdAt: d.createdAt.toISOString(),
		updatedAt: d.updatedAt.toISOString(),
	};
}

export async function dispatchWire(
	db: Executor,
	id: string,
): Promise<Dispatch | null> {
	const [r] = await dispatchQuery(db).where(eq(dispatch.id, id));
	return r ? toDispatchWire(r) : null;
}

export type DispatchFilters = {
	status?: DispatchStatus;
	rosterEntryId?: string;
	cursor?: string;
	limit: number;
};

/** A mission's dispatches, newest first (created_at desc, id desc). */
export async function listDispatches(
	db: Executor,
	missionId: string,
	q: DispatchFilters,
): Promise<{ items: Dispatch[]; nextCursor: string | null }> {
	const rows = await dispatchQuery(db)
		.where(
			and(
				eq(dispatch.missionId, missionId),
				q.status ? eq(dispatch.status, q.status) : undefined,
				q.rosterEntryId
					? eq(dispatch.rosterEntryId, q.rosterEntryId)
					: undefined,
				after(dispatch, q.cursor),
			),
		)
		.orderBy(desc(dispatch.createdAt), desc(dispatch.id))
		.limit(q.limit + 1);
	const { items, nextCursor } = toPage(
		rows.map((r) => ({ createdAt: r.row.createdAt, id: r.row.id, r })),
		q.limit,
	);
	return { items: items.map((i) => toDispatchWire(i.r)), nextCursor };
}

export type DispatchCaller = {
	dispatch: DispatchRow;
	rosterEntry: RosterEntryRow;
	roles: Role[];
};

/**
 * The dispatch an access token's hash names, with its entry and the roles
 * of the entry's template: what the caller middleware resolves a bearer
 * token to. Whatever its status; the middleware refuses all but running.
 * Null when no dispatch has this hash, or its entry or template has been
 * deleted, so a removed agent's token stops working.
 */
export async function dispatchByTokenSha256(
	db: Executor,
	tokenSha256: string,
): Promise<DispatchCaller | null> {
	const [r] = await db
		.select({
			dispatch,
			rosterEntry,
			roles: agentTemplate.roles,
		})
		.from(dispatch)
		.innerJoin(
			rosterEntry,
			and(eq(rosterEntry.id, dispatch.rosterEntryId), live(rosterEntry)),
		)
		.innerJoin(
			agentTemplate,
			and(
				eq(agentTemplate.id, rosterEntry.agentTemplateId),
				live(agentTemplate),
			),
		)
		.where(eq(dispatch.tokenSha256, tokenSha256));
	return r ?? null;
}

/**
 * The template of the identity version the report's dispatch froze, only
 * when that version's hash is the one the report records: a reconstructed
 * report can carry another hash, and then has no ref.
 */
const reportVersionTemplate = alias(agentTemplate, "report_version_template");

function reportQuery(db: Executor) {
	return db
		.select({
			row: completionReport,
			versionSlug: reportVersionTemplate.slug,
			versionNumber: agentIdentityVersion.number,
		})
		.from(completionReport)
		.innerJoin(dispatch, eq(dispatch.id, completionReport.dispatchId))
		.leftJoin(
			agentIdentityVersion,
			and(
				eq(agentIdentityVersion.id, dispatch.agentIdentityVersionId),
				eq(agentIdentityVersion.sha256, completionReport.agentVersionSha256),
			),
		)
		.leftJoin(
			reportVersionTemplate,
			eq(reportVersionTemplate.id, agentIdentityVersion.agentTemplateId),
		);
}

export type ReportWireRow = Awaited<
	ReturnType<ReturnType<typeof reportQuery>["execute"]>
>[number];

/** The contract's CompletionReport, field by field, stored snake_case mapped to camelCase. */
export function toReportWire(r: ReportWireRow): CompletionReport {
	const c = r.row;
	return {
		id: c.id,
		dispatchId: c.dispatchId,
		missionId: c.missionId,
		rosterEntryId: c.rosterEntryId,
		status: c.status,
		haltReason: c.haltReason,
		softCeilingCrossed: c.softCeilingCrossed,
		actualTokens: c.actualTokens,
		agentVersionSha256: c.agentVersionSha256,
		agentVersionRef: ref(r.versionSlug, r.versionNumber),
		skillsSha256: c.skillsSha256,
		versionSource: c.versionSource,
		model: c.model,
		artifactsRead: c.artifactsRead.map((a) => ({
			path: a.path,
			sha256: a.sha256,
		})),
		artifactsWritten: c.artifactsWritten.map((a) => ({
			path: a.path,
			sha256: a.sha256,
		})),
		filesTouched: c.filesTouched,
		fileTypesTouched: [...c.fileTypesTouched],
		rereads: c.rereads,
		blockers: c.blockers.map((b) => ({
			description: b.description,
			workaround: b.workaround,
			provisioningGap: b.provisioning_gap,
		})),
		edgeMismatches: c.edgeMismatches.map((e) => ({
			path: e.path,
			readSha256: e.read_sha256,
			writtenSha256: e.written_sha256,
			producerDispatchId: e.producer_dispatch_id,
		})),
		filedBy: c.filedBy,
		createdAt: c.createdAt.toISOString(),
	};
}

export async function reportWire(
	db: Executor,
	id: string,
): Promise<CompletionReport | null> {
	const [r] = await reportQuery(db).where(
		and(eq(completionReport.id, id), live(completionReport)),
	);
	return r ? toReportWire(r) : null;
}

/** A mission's live reports, newest first (created_at desc, id desc). */
export async function listReports(
	db: Executor,
	missionId: string,
	page: { cursor?: string; limit: number },
): Promise<{ items: CompletionReport[]; nextCursor: string | null }> {
	const rows = await reportQuery(db)
		.where(
			and(
				eq(completionReport.missionId, missionId),
				live(completionReport),
				after(completionReport, page.cursor),
			),
		)
		.orderBy(desc(completionReport.createdAt), desc(completionReport.id))
		.limit(page.limit + 1);
	const { items, nextCursor } = toPage(
		rows.map((r) => ({ createdAt: r.row.createdAt, id: r.row.id, r })),
		page.limit,
	);
	return { items: items.map((i) => toReportWire(i.r)), nextCursor };
}

/**
 * What a mission has spent: spend_usd summed over all its dispatches, every
 * status. Summed as numeric in Postgres, so the total is exact to six places
 * before it becomes a number.
 */
export async function missionSpentUsd(
	db: Executor,
	missionId: string,
): Promise<number> {
	const [r] = await db
		.select({
			total: sql<string>`coalesce(sum(${dispatch.spendUsd}), 0)::text`,
		})
		.from(dispatch)
		.where(eq(dispatch.missionId, missionId));
	return Number(r?.total ?? 0);
}
