import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	arrayOverlaps,
	desc,
	eq,
	ilike,
	inArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	ok,
	page,
	type Skill,
	type SkillListItem,
	type SkillListQuery,
	skillContract,
} from "../contract";
import { logActivity } from "../db/activity";
import { skill, skillSource } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { type Executor, type Tx, withTx } from "../db/tx";
import { skillContentSha256 } from "../lib/skill-hash";
import { ApiError } from "../middleware/errors";
import {
	after,
	containsPattern,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

/** Everything a list item carries. The text columns are left out of list reads. */
export const skillListColumns = {
	id: skill.id,
	slug: skill.slug,
	name: skill.name,
	description: skill.description,
	layer: skill.layer,
	type: skill.type,
	grants: skill.grants,
	ioShape: skill.ioShape,
	recommendedFor: skill.recommendedFor,
	sourceId: skillSource.id,
	sourceName: skillSource.name,
	sourceKind: skillSource.kind,
	contentSha256: skill.contentSha256,
	status: skill.status,
	reviewedBy: skill.reviewedBy,
	reviewedAt: skill.reviewedAt,
	version: skill.version,
	createdAt: skill.createdAt,
	updatedAt: skill.updatedAt,
};

const fullColumns = {
	...skillListColumns,
	contentMd: skill.contentMd,
	avelEnhancementMd: skill.avelEnhancementMd,
};

type SkillRow = typeof skill.$inferSelect;
type SourceRow = typeof skillSource.$inferSelect;

type ListRow = Pick<
	SkillRow,
	| "id"
	| "slug"
	| "name"
	| "description"
	| "layer"
	| "type"
	| "grants"
	| "ioShape"
	| "recommendedFor"
	| "contentSha256"
	| "status"
	| "reviewedBy"
	| "reviewedAt"
	| "version"
	| "createdAt"
	| "updatedAt"
> & {
	sourceId: SourceRow["id"];
	sourceName: SourceRow["name"];
	sourceKind: SourceRow["kind"];
};
type FullRow = ListRow & Pick<SkillRow, "contentMd" | "avelEnhancementMd">;

/**
 * The skill_capability_fields CHECK guarantees a capability has grants and
 * ioShape and a knowledge skill has neither. A row that breaks it is a
 * server bug, so it is a 500, never a shape the contract does not describe.
 */
function variant(row: ListRow) {
	if (row.type === "knowledge") {
		return { type: "knowledge" as const, grants: null, ioShape: null };
	}
	if (!row.grants || !row.ioShape) {
		throw new Error(
			`skill ${row.id} is a capability without grants or ioShape`,
		);
	}
	return {
		type: "capability" as const,
		grants: row.grants,
		ioShape: row.ioShape,
	};
}

export function toSkillListItem(row: ListRow): SkillListItem {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		layer: row.layer,
		...variant(row),
		recommendedFor: row.recommendedFor,
		source: { id: row.sourceId, name: row.sourceName, kind: row.sourceKind },
		contentSha256: row.contentSha256,
		status: row.status,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function toWire(row: FullRow): Skill {
	return {
		...toSkillListItem(row),
		contentMd: row.contentMd,
		avelEnhancementMd: row.avelEnhancementMd,
	};
}

function filtersFor(query: SkillListQuery): SQL | undefined {
	const pattern = query.q ? containsPattern(query.q) : undefined;
	return and(
		live(skill),
		pattern
			? or(
					ilike(skill.slug, pattern),
					ilike(skill.name, pattern),
					ilike(skill.description, pattern),
				)
			: undefined,
		query.layer ? inArray(skill.layer, query.layer) : undefined,
		query.type ? eq(skill.type, query.type) : undefined,
		query.status ? inArray(skill.status, query.status) : undefined,
		query.role ? arrayOverlaps(skill.recommendedFor, query.role) : undefined,
		query.sourceId ? eq(skill.sourceId, query.sourceId) : undefined,
	);
}

/** One live skill with its text, or undefined. */
async function findLive(
	db: Executor,
	where: SQL | undefined,
): Promise<FullRow | undefined> {
	const [row] = await db
		.select(fullColumns)
		.from(skill)
		.innerJoin(skillSource, eq(skillSource.id, skill.sourceId))
		.where(and(where, live(skill)));
	return row;
}

/**
 * The source a skill names, locked for share so it cannot be deleted between
 * this check and the write (skill-source remove locks it for update).
 */
async function requireLiveSource(tx: Tx, sourceId: string): Promise<void> {
	const [row] = await tx
		.select({ id: skillSource.id })
		.from(skillSource)
		.where(and(eq(skillSource.id, sourceId), live(skillSource)))
		.for("share");
	if (!row) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"The skill source does not exist",
			{
				details: { reason: "skill_source_not_found" },
			},
		);
	}
}

function slugTaken(slug: string): ApiError {
	return new ApiError("CONFLICT", `A live skill already has the slug ${slug}`);
}

async function requireFreeSlug(tx: Tx, slug: string): Promise<void> {
	const [taken] = await tx
		.select({ id: skill.id })
		.from(skill)
		.where(and(eq(skill.slug, slug), live(skill)))
		.limit(1);
	if (taken) throw slugTaken(slug);
}

/**
 * Two writes racing on one slug both pass requireFreeSlug; the partial
 * unique index stops the second. Postgres aborts the transaction on that
 * error, so it is translated outside withTx, never caught inside it.
 */
function isSlugViolation(err: unknown): boolean {
	for (let e = err; e instanceof Error; e = e.cause) {
		const pg = e as Error & { code?: string; constraint_name?: string };
		if (pg.code === "23505" && pg.constraint_name === "skill_slug_live_uq") {
			return true;
		}
	}
	return false;
}

async function translatingSlug<T>(
	slug: string | undefined,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (slug && isSlugViolation(err)) throw slugTaken(slug);
		throw err;
	}
}

/** The skill, locked for the rest of the transaction, so transitions run one at a time. */
async function lockSkill(tx: Tx, id: string) {
	const [row] = await tx
		.select()
		.from(skill)
		.where(and(eq(skill.id, id), live(skill)))
		.for("update");
	if (!row) throw notFound("skill", id);
	return row;
}

export function skillRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(skillContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select(skillListColumns)
					.from(skill)
					.innerJoin(skillSource, eq(skillSource.id, skill.sourceId))
					.where(and(filters, after(skill, query.cursor)))
					.orderBy(desc(skill.createdAt), desc(skill.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(skill)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(items.map(toSkillListItem), nextCursor, counted?.total ?? 0),
			};
		},

		get: async ({ params }) => {
			const row = await findLive(deps.db(), eq(skill.id, params.id));
			if (!row) throw notFound("skill", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		// The slug is unique among live skills (skill_slug_live_uq).
		getBySlug: async ({ params }) => {
			const row = await findLive(deps.db(), eq(skill.slug, params.slug));
			if (!row) {
				throw new ApiError("NOT_FOUND", `No skill with slug ${params.slug}`);
			}
			return { status: 200, body: ok(toWire(row)) };
		},

		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await translatingSlug(body.slug, () =>
				withTx(deps.db(), async (tx) => {
					await requireLiveSource(tx, body.sourceId);
					await requireFreeSlug(tx, body.slug);
					const hashed = {
						description: body.description,
						contentMd: body.contentMd,
						avelEnhancementMd: body.avelEnhancementMd ?? null,
						type: body.type,
						layer: body.layer,
						...(body.type === "capability"
							? { grants: body.grants, ioShape: body.ioShape }
							: { grants: null, ioShape: null }),
					};
					const values = {
						id: deps.ids.next(),
						slug: body.slug,
						name: body.name,
						...hashed,
						recommendedFor: body.recommendedFor,
						sourceId: body.sourceId,
						contentSha256: skillContentSha256(hashed),
						status: "draft" as const,
						reviewedBy: null,
						reviewedAt: null,
						version: 1,
						...stamp(deps.clock),
					};
					await tx.insert(skill).values(values);
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "skill.created",
						entityType: "skill",
						entityId: values.id,
						requestId: ctx.requestId,
						payload: {
							slug: values.slug,
							type: values.type,
							layer: values.layer,
							contentSha256: values.contentSha256,
						},
					});
					return findLive(tx, eq(skill.id, values.id));
				}),
			);
			if (!row) throw new Error("a created skill was not readable");
			return { status: 201, body: ok(toWire(row)) };
		},

		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await translatingSlug(body.slug, () =>
				withTx(deps.db(), async (tx) => {
					const current = await lockSkill(tx, params.id);
					if (current.status === "retired") {
						throw new ApiError("CONFLICT", "A retired skill cannot be edited");
					}
					if (body.sourceId && body.sourceId !== current.sourceId) {
						await requireLiveSource(tx, body.sourceId);
					}
					if (body.slug && body.slug !== current.slug) {
						await requireFreeSlug(tx, body.slug);
					}

					// Moving to knowledge clears grants and ioShape; the contract
					// refuses a body that moves to knowledge and sends non-null ones.
					const toKnowledge = body.type === "knowledge";
					const type = body.type ?? current.type;
					const grants =
						body.grants !== undefined
							? body.grants
							: toKnowledge
								? null
								: current.grants;
					const ioShape =
						body.ioShape !== undefined
							? body.ioShape
							: toKnowledge
								? null
								: current.ioShape;
					const consistent =
						type === "capability"
							? grants !== null && ioShape !== null
							: grants === null && ioShape === null;
					if (!consistent) {
						throw new ApiError(
							"PRECONDITION_FAILED",
							type === "capability"
								? "A capability needs grants and ioShape"
								: "A knowledge skill carries no grants or ioShape",
							{ details: { reason: "skill_capability_mismatch" } },
						);
					}

					const hashed = {
						description: body.description ?? current.description,
						contentMd: body.contentMd ?? current.contentMd,
						avelEnhancementMd:
							body.avelEnhancementMd !== undefined
								? body.avelEnhancementMd
								: current.avelEnhancementMd,
						type,
						layer: body.layer ?? current.layer,
						grants,
						ioShape,
					};
					const contentSha256 = skillContentSha256(hashed);
					// Both sides recomputed, so a stored hash written some other way
					// cannot fake a change. Approval pinned the old content.
					const returnedToDraft =
						current.status === "approved" &&
						contentSha256 !== skillContentSha256(current);
					const version = current.version + 1;
					await tx
						.update(skill)
						.set({
							...hashed,
							slug: body.slug ?? current.slug,
							name: body.name ?? current.name,
							recommendedFor: body.recommendedFor ?? current.recommendedFor,
							sourceId: body.sourceId ?? current.sourceId,
							contentSha256,
							version,
							...(returnedToDraft
								? {
										status: "draft" as const,
										reviewedBy: null,
										reviewedAt: null,
									}
								: {}),
							...touch(deps.clock),
						})
						.where(eq(skill.id, params.id));
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "skill.updated",
						entityType: "skill",
						entityId: params.id,
						requestId: ctx.requestId,
						// Field names only: the text can be 100 KB.
						payload: {
							fields: Object.keys(body).sort(),
							version,
							contentSha256,
							returnedToDraft,
						},
					});
					return findLive(tx, eq(skill.id, params.id));
				}),
			);
			if (!row) throw notFound("skill", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		approve: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockSkill(tx, params.id);
				if (current.status !== "draft") {
					throw new ApiError(
						"CONFLICT",
						`A ${current.status} skill cannot be approved`,
					);
				}
				if (current.contentSha256 !== body.contentSha256) {
					throw new ApiError(
						"CONFLICT",
						"The skill changed since this hash was reviewed",
					);
				}
				await tx
					.update(skill)
					.set({
						status: "approved",
						reviewedBy: operator.id,
						reviewedAt: deps.clock.now(),
						...touch(deps.clock),
					})
					.where(eq(skill.id, params.id));
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "skill.approved",
					entityType: "skill",
					entityId: params.id,
					requestId: ctx.requestId,
					payload: { contentSha256: current.contentSha256 },
				});
				return findLive(tx, eq(skill.id, params.id));
			});
			if (!row) throw notFound("skill", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},

		retire: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const row = await withTx(deps.db(), async (tx) => {
				const current = await lockSkill(tx, params.id);
				if (current.status === "retired") {
					throw new ApiError("CONFLICT", "The skill is already retired");
				}
				await tx
					.update(skill)
					.set({ status: "retired", ...touch(deps.clock) })
					.where(eq(skill.id, params.id));
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "skill.retired",
					entityType: "skill",
					entityId: params.id,
					requestId: ctx.requestId,
					payload: { from: current.status },
				});
				return findLive(tx, eq(skill.id, params.id));
			});
			if (!row) throw notFound("skill", params.id);
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
