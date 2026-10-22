import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { CanonPart } from "../../contract";
import {
	activityLog,
	client,
	dispatch,
	engagement,
	finding,
	intake,
	mission,
} from "../../db/schema";
import { live } from "../../db/schema/columns";
import type { CanonScope, Executor } from "../../db/tx";

/**
 * Fetch mode's one read tool (J, 2026-10-20). It reads the command center's
 * operational data, an allowlist of entities, and never a client's words:
 * no notes, intake source, brief, dispatch brief or activity payload, and
 * never connections, repo policies or credentials (DECISIONS-V2, *Canon
 * reads clients, read-only*).
 *
 * An open session reads every client's rows. A client session reads only
 * its own client's, and that is enforced here, in code, by joining every
 * row to its client: these tables are not under row-level security (J's
 * ruling, 2026-10-19). [attestation], covered by tests/api/canon-fetch.test.ts.
 */

export const FETCH_ENTITIES = [
	"clients",
	"engagements",
	"intakes",
	"missions",
	"dispatches",
	"spend",
	"activity",
	"gate_runs",
	"findings",
] as const;

export type FetchEntity = (typeof FETCH_ENTITIES)[number];

const uuid = z.string().uuid();

export const fetchInput = z
	.object({
		entity: z.enum(FETCH_ENTITIES),
		/** One row by id; the other filters still apply. */
		id: uuid.optional(),
		clientId: uuid.optional(),
		engagementId: uuid.optional(),
		missionId: uuid.optional(),
		status: z.string().min(1).max(40).optional(),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.strict();

export type FetchInput = z.infer<typeof fetchInput>;

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;

export type FetchResult = {
	/** What the model reads: the rows as JSON. */
	text: string;
	/** What the operator sees: a table, or a card for one row by id. */
	parts: CanonPart[];
	isError?: boolean;
};

/** The singular, as the activity log names it, for a card. */
const ENTITY_TYPE: Partial<Record<FetchEntity, string>> = {
	clients: "client",
	engagements: "engagement",
	intakes: "intake",
	missions: "mission",
	dispatches: "dispatch",
	findings: "finding",
};

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const num = (v: string | null) => (v === null ? null : Number(v));

type Query = { rows: Row[]; columns: Array<{ key: string; label: string }> };

/** The client a row must belong to, or null in an open session. */
function ownClient(scope: CanonScope): string | null {
	return scope.kind === "client" ? scope.clientId : null;
}

async function read(
	db: Executor,
	scope: CanonScope,
	input: FetchInput,
): Promise<Query> {
	const own = ownClient(scope);
	// In a client session every row joins to that client; a clientId filter
	// naming another is refused before this runs.
	const clientIs = (col: SQL | typeof engagement.clientId) =>
		own !== null
			? sql`${col} = ${own}`
			: input.clientId
				? sql`${col} = ${input.clientId}`
				: undefined;
	const limit = input.limit;

	switch (input.entity) {
		case "clients": {
			const rows = await db
				.select({ id: client.id, name: client.name, status: client.status })
				.from(client)
				.where(
					and(
						live(client),
						clientIs(sql`${client.id}`),
						input.id ? eq(client.id, input.id) : undefined,
						input.status
							? sql`${client.status}::text = ${input.status}`
							: undefined,
					),
				)
				.orderBy(desc(client.createdAt), desc(client.id))
				.limit(limit);
			return {
				rows,
				columns: [
					{ key: "name", label: "Client" },
					{ key: "status", label: "Status" },
				],
			};
		}
		case "engagements": {
			const rows = await db
				.select({
					id: engagement.id,
					clientId: engagement.clientId,
					name: engagement.name,
					status: engagement.status,
					startedAt: engagement.startedAt,
					closedAt: engagement.closedAt,
				})
				.from(engagement)
				.innerJoin(
					client,
					and(eq(client.id, engagement.clientId), live(client)),
				)
				.where(
					and(
						live(engagement),
						clientIs(engagement.clientId),
						input.id ? eq(engagement.id, input.id) : undefined,
						input.status
							? sql`${engagement.status}::text = ${input.status}`
							: undefined,
					),
				)
				.orderBy(desc(engagement.createdAt), desc(engagement.id))
				.limit(limit);
			return {
				rows: rows.map((r) => ({
					...r,
					startedAt: iso(r.startedAt),
					closedAt: iso(r.closedAt),
				})),
				columns: [
					{ key: "name", label: "Engagement" },
					{ key: "status", label: "Status" },
					{ key: "startedAt", label: "Started" },
				],
			};
		}
		case "intakes": {
			const rows = await db
				.select({
					id: intake.id,
					engagementId: intake.engagementId,
					status: intake.status,
					missionId: intake.missionId,
					repoUrl: intake.repoUrl,
					createdAt: intake.createdAt,
				})
				.from(intake)
				.innerJoin(
					engagement,
					and(eq(engagement.id, intake.engagementId), live(engagement)),
				)
				.innerJoin(
					client,
					and(eq(client.id, engagement.clientId), live(client)),
				)
				.where(
					and(
						live(intake),
						clientIs(engagement.clientId),
						input.id ? eq(intake.id, input.id) : undefined,
						input.engagementId
							? eq(intake.engagementId, input.engagementId)
							: undefined,
						input.status
							? sql`${intake.status}::text = ${input.status}`
							: undefined,
					),
				)
				.orderBy(desc(intake.createdAt), desc(intake.id))
				.limit(limit);
			return {
				rows: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
				columns: [
					{ key: "status", label: "Status" },
					{ key: "repoUrl", label: "Repository" },
					{ key: "createdAt", label: "Created" },
				],
			};
		}
		case "missions":
		case "spend": {
			const spent = sql<string>`(select coalesce(sum(d.spend_usd), 0)::text from dispatch d where d.mission_id = ${mission.id})`;
			const rows = await db
				.select({
					id: mission.id,
					engagementId: mission.engagementId,
					clientId: engagement.clientId,
					type: mission.type,
					status: mission.status,
					sprintN: mission.sprintN,
					spendCeilingUsd: mission.spendCeilingUsd,
					spentUsd: spent,
					createdAt: mission.createdAt,
				})
				.from(mission)
				.leftJoin(
					engagement,
					and(eq(engagement.id, mission.engagementId), live(engagement)),
				)
				.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
				.where(
					and(
						live(mission),
						// A client mission whose engagement or client is removed is
						// hidden, as GET /api/missions/:id hides it.
						sql`(${mission.origin} = 'internal' or ${client.id} is not null)`,
						clientIs(engagement.clientId),
						input.id ? eq(mission.id, input.id) : undefined,
						input.engagementId
							? eq(mission.engagementId, input.engagementId)
							: undefined,
						input.status
							? sql`${mission.status}::text = ${input.status}`
							: undefined,
					),
				)
				.orderBy(desc(mission.createdAt), desc(mission.id))
				.limit(limit);
			return {
				rows: rows.map((r) => ({
					...r,
					spendCeilingUsd: num(r.spendCeilingUsd),
					spentUsd: Number(r.spentUsd),
					createdAt: iso(r.createdAt),
				})),
				columns:
					input.entity === "spend"
						? [
								{ key: "type", label: "Mission" },
								{ key: "status", label: "Status" },
								{ key: "spentUsd", label: "Spent (USD)" },
								{ key: "spendCeilingUsd", label: "Ceiling (USD)" },
							]
						: [
								{ key: "type", label: "Mission" },
								{ key: "status", label: "Status" },
								{ key: "sprintN", label: "Sprint" },
								{ key: "spentUsd", label: "Spent (USD)" },
							],
			};
		}
		case "dispatches": {
			const rows = await db
				.select({
					id: dispatch.id,
					missionId: dispatch.missionId,
					status: dispatch.status,
					haltReason: dispatch.haltReason,
					model: dispatch.model,
					tokensUsed: dispatch.tokensUsed,
					spendUsd: dispatch.spendUsd,
					startedAt: dispatch.startedAt,
					closedAt: dispatch.closedAt,
				})
				.from(dispatch)
				.innerJoin(
					mission,
					and(eq(mission.id, dispatch.missionId), live(mission)),
				)
				.leftJoin(
					engagement,
					and(eq(engagement.id, mission.engagementId), live(engagement)),
				)
				.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
				.where(
					and(
						sql`(${mission.origin} = 'internal' or ${client.id} is not null)`,
						clientIs(engagement.clientId),
						input.id ? eq(dispatch.id, input.id) : undefined,
						input.missionId
							? eq(dispatch.missionId, input.missionId)
							: undefined,
						input.status
							? sql`${dispatch.status}::text = ${input.status}`
							: undefined,
					),
				)
				.orderBy(desc(dispatch.createdAt), desc(dispatch.id))
				.limit(limit);
			return {
				rows: rows.map((r) => ({
					...r,
					spendUsd: Number(r.spendUsd),
					startedAt: iso(r.startedAt),
					closedAt: iso(r.closedAt),
				})),
				columns: [
					{ key: "status", label: "Status" },
					{ key: "model", label: "Model" },
					{ key: "tokensUsed", label: "Tokens" },
					{ key: "spendUsd", label: "Spent (USD)" },
				],
			};
		}
		case "activity":
		case "gate_runs": {
			const gate = input.entity === "gate_runs";
			const rows = await db
				.select({
					id: activityLog.id,
					at: activityLog.at,
					action: activityLog.action,
					entityType: activityLog.entityType,
					entityId: activityLog.entityId,
					missionId: activityLog.missionId,
					engagementId: activityLog.engagementId,
					// A gate run's result and commit; no other payload is read. A run
					// from before decide() version 3 stored a verdict instead: block
					// reads as fail and anything else as pass, never as verified,
					// because telling verified apart needs the receipt's reasons.
					result: gate
						? sql<
								string | null
							>`coalesce(${activityLog.payload}->>'result', case ${activityLog.payload}->>'verdict' when 'block' then 'fail' when 'pass' then 'pass' end)`
						: sql<null>`null`,
					commitSha: gate
						? sql<string | null>`${activityLog.payload}->>'commitSha'`
						: sql<null>`null`,
				})
				.from(activityLog)
				.leftJoin(engagement, eq(engagement.id, activityLog.engagementId))
				.where(
					and(
						gate ? eq(activityLog.action, "mission.gate_run") : undefined,
						// A client session sees only rows tied to its client's
						// engagements; rows tied to none are the agency's.
						own !== null ? isNotNull(activityLog.engagementId) : undefined,
						clientIs(engagement.clientId),
						input.id ? eq(activityLog.id, input.id) : undefined,
						input.missionId
							? eq(activityLog.missionId, input.missionId)
							: undefined,
						input.engagementId
							? eq(activityLog.engagementId, input.engagementId)
							: undefined,
					),
				)
				.orderBy(desc(activityLog.at), desc(activityLog.id))
				.limit(limit);
			return {
				rows: rows.map((r) => {
					const { result, commitSha, ...rest } = r;
					return {
						...rest,
						at: iso(r.at),
						...(gate ? { result, commitSha } : {}),
					};
				}),
				columns: gate
					? [
							{ key: "at", label: "Run" },
							{ key: "result", label: "Result" },
							{ key: "commitSha", label: "Commit" },
						]
					: [
							{ key: "at", label: "When" },
							{ key: "action", label: "Action" },
							{ key: "entityType", label: "On" },
						],
			};
		}
		case "findings": {
			const rows = await db
				.select({
					id: finding.id,
					missionId: finding.missionId,
					rule: finding.rule,
					severity: finding.severity,
					class: finding.class,
					status: finding.status,
					caughtBy: finding.caughtBy,
					createdAt: finding.createdAt,
				})
				.from(finding)
				.innerJoin(
					mission,
					and(eq(mission.id, finding.missionId), live(mission)),
				)
				.leftJoin(
					engagement,
					and(eq(engagement.id, mission.engagementId), live(engagement)),
				)
				.leftJoin(client, and(eq(client.id, engagement.clientId), live(client)))
				.where(
					and(
						sql`(${mission.origin} = 'internal' or ${client.id} is not null)`,
						clientIs(engagement.clientId),
						input.id ? eq(finding.id, input.id) : undefined,
						input.missionId
							? eq(finding.missionId, input.missionId)
							: undefined,
						input.status
							? sql`${finding.status}::text = ${input.status}`
							: undefined,
					),
				)
				.orderBy(desc(finding.createdAt), desc(finding.id))
				.limit(limit);
			return {
				rows: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
				columns: [
					{ key: "rule", label: "Rule" },
					{ key: "severity", label: "Severity" },
					{ key: "status", label: "Status" },
				],
			};
		}
	}
}

/**
 * Runs one fetch in the session's scope. A client session asking for
 * another client gets the tool's error, never an empty answer that could
 * read as "nothing there".
 */
export async function fetchData(
	db: Executor,
	scope: CanonScope,
	raw: unknown,
): Promise<FetchResult> {
	const parsed = fetchInput.safeParse(raw);
	if (!parsed.success) {
		return {
			text: `The fetch input does not fit: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
			parts: [],
			isError: true,
		};
	}
	const input = parsed.data;
	const own = ownClient(scope);
	if (own !== null && input.clientId && input.clientId !== own) {
		return {
			text: "This session reads only its own client.",
			parts: [],
			isError: true,
		};
	}
	const { rows, columns } = await read(db, scope, input);
	const entityType = ENTITY_TYPE[input.entity];
	const one = input.id && rows.length === 1 ? rows[0] : undefined;
	const parts: CanonPart[] =
		one && entityType
			? [{ type: "entity", entityType, id: input.id as string, fields: one }]
			: [{ type: "table", columns, rows }];
	return {
		text: JSON.stringify({ entity: input.entity, count: rows.length, rows }),
		parts,
	};
}
