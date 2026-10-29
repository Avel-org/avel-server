import { tsr } from "@ts-rest/serverless/fetch";
import { and, count, desc, eq } from "drizzle-orm";
import {
	ok,
	type Proposal,
	playbookProposalPayload,
	presetProposalPayload,
	proposalContract,
} from "../contract";
import { logActivity } from "../db/activity";
import { proposal } from "../db/schema";
import { touch } from "../db/schema/columns";
import { type Tx, withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import {
	createPlaybook,
	isTypeViolation,
	livePlaybook,
	type OperatorWrite,
	replacePlaybook,
	typeTaken,
} from "./playbooks";
import { createPreset } from "./presets";
import {
	after,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof proposal.$inferSelect;

function toWire(row: Row): Proposal {
	return {
		id: row.id,
		kind: row.kind,
		source: row.source,
		engagementId: row.engagementId,
		missionId: row.missionId,
		summary: row.summary,
		payload: row.payload,
		premise: row.premise,
		status: row.status,
		reason: row.reason,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The proposal, locked, if it is pending; refused otherwise. */
async function pending(tx: Tx, id: string): Promise<Row> {
	const [row] = await tx
		.select()
		.from(proposal)
		.where(eq(proposal.id, id))
		.for("update");
	if (!row) throw notFound("proposal", id);
	if (row.status !== "pending") {
		throw new ApiError(
			"PRECONDITION_FAILED",
			`The proposal is already ${row.status}`,
			{ details: { reason: "proposal_not_pending" } },
		);
	}
	return row;
}

/** A payload its kind cannot parse is a broken row: a 500, never a guess. */
function payloadOf<T>(
	row: Row,
	schema: {
		safeParse(v: unknown): { success: true; data: T } | { success: false };
	},
): T {
	const parsed = schema.safeParse(row.payload);
	if (!parsed.success)
		throw new Error(`proposal ${row.id}: ${row.kind} payload does not parse`);
	return parsed.data;
}

/**
 * Starts the kind's action through the normal path: the same writes, checks
 * and activity rows as the playbook and preset routes, with the approving
 * operator as their actor. Returns what was written, for proposal.approved.
 */
async function act(
	tx: Tx,
	deps: RouteDeps,
	row: Row,
	by: OperatorWrite,
): Promise<{ playbookId?: string; presetId?: string }> {
	if (row.kind === "preset") {
		const { preset } = payloadOf(row, presetProposalPayload);
		return { presetId: (await createPreset(tx, deps, preset, by)).id };
	}
	if (row.kind === "playbook") {
		const p = payloadOf(row, playbookProposalPayload);
		const { missionType, ...fields } = p.playbook;
		// Lock and check the premise before writing anything, so a stale
		// replacement leaves no new preset behind (the transaction rolls back anyway).
		const current =
			p.replacesVersion === null
				? null
				: await livePlaybook(tx, missionType, true);
		if (current && current.version !== p.replacesVersion) {
			throw new ApiError(
				"PRECONDITION_FAILED",
				`The ${missionType} playbook is at version ${current.version}, not the ${p.replacesVersion} this proposal replaces`,
				{ details: { reason: "proposal_premise_changed" } },
			);
		}
		const presetId =
			p.newPreset !== null
				? (await createPreset(tx, deps, p.newPreset, by)).id
				: fields.defaultPresetId;
		if (presetId === null)
			throw new Error(`proposal ${row.id}: playbook names no preset`);
		const written = current
			? await replacePlaybook(
					tx,
					deps,
					current,
					{ ...fields, defaultPresetId: presetId },
					by,
				)
			: await createPlaybook(
					tx,
					deps,
					{ ...fields, missionType, defaultPresetId: presetId },
					by,
				);
		return {
			playbookId: written.id,
			...(p.newPreset !== null ? { presetId } : {}),
		};
	}
	throw new ApiError(
		"PRECONDITION_FAILED",
		`Approving a ${row.kind} proposal is not built yet`,
		{ details: { reason: "proposal_action_not_built" } },
	);
}

/**
 * The proposal queue (module 14; J, 2026-10-24). Canon writes playbook and
 * preset proposals (2026-10-28). Deciding locks the row, so two decisions on
 * one proposal serialize and the second refuses.
 */
export function proposalRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(proposalContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = query.status
				? eq(proposal.status, query.status)
				: undefined;
			const [rows, byStatus] = await Promise.all([
				db
					.select()
					.from(proposal)
					.where(and(filters, after(proposal, query.cursor)))
					.orderBy(desc(proposal.createdAt), desc(proposal.id))
					.limit(query.limit + 1),
				db
					.select({ status: proposal.status, n: count() })
					.from(proposal)
					.groupBy(proposal.status),
			]);
			const counts = { pending: 0, approved: 0, dismissed: 0, expired: 0 };
			for (const s of byStatus) counts[s.status] = s.n;
			const total = query.status
				? counts[query.status]
				: counts.pending + counts.approved + counts.dismissed + counts.expired;
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items.map(toWire),
					meta: { nextCursor, total, counts },
				},
			};
		},

		approve: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const by = { actorUserId: operator.id, requestId: ctx.requestId };
			try {
				const row = await withTx(deps.db(), async (tx) => {
					const found = await pending(tx, params.id);
					// The kind's action and the decision commit together, or neither does.
					const written = await act(tx, deps, found, by);
					const [updated] = await tx
						.update(proposal)
						.set({
							status: "approved",
							decidedBy: operator.id,
							decidedAt: deps.clock.now(),
							...touch(deps.clock),
						})
						.where(eq(proposal.id, found.id))
						.returning();
					if (!updated) throw new Error("proposal update returned no row");
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "proposal.approved",
						entityType: "proposal",
						entityId: found.id,
						missionId: found.missionId,
						engagementId: found.engagementId,
						requestId: ctx.requestId,
						payload: { kind: found.kind, ...written },
					});
					return updated;
				});
				return { status: 200, body: ok(toWire(row)) };
			} catch (err) {
				// Postgres aborts the transaction on the unique index, so this is
				// translated outside withTx, as the playbook create route does.
				if (isTypeViolation(err)) {
					const [row] = await deps
						.db()
						.select({ payload: proposal.payload })
						.from(proposal)
						.where(eq(proposal.id, params.id));
					const type = playbookProposalPayload.safeParse(row?.payload);
					throw typeTaken(
						type.success ? type.data.playbook.missionType : "this type",
					);
				}
				throw err;
			}
		},

		dismiss: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const found = await pending(tx, params.id);
				const [updated] = await tx
					.update(proposal)
					.set({
						status: "dismissed",
						reason: body.reason,
						decidedBy: operator.id,
						decidedAt: deps.clock.now(),
						...touch(deps.clock),
					})
					.where(eq(proposal.id, found.id))
					.returning();
				if (!updated) throw new Error("proposal update returned no row");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "proposal.dismissed",
					entityType: "proposal",
					entityId: found.id,
					missionId: found.missionId,
					engagementId: found.engagementId,
					requestId: ctx.requestId,
					payload: { kind: found.kind, reason: body.reason },
				});
				return updated;
			});
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
