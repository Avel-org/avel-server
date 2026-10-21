import { tsr } from "@ts-rest/serverless/fetch";
import {
	and,
	arrayOverlaps,
	asc,
	desc,
	eq,
	ilike,
	inArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	type AgentTemplate,
	type AgentTemplateListQuery,
	accessFor,
	agentTemplateContract,
	type IdentityVersion,
	type IdentityVersionSummary,
	identityVersionContract,
	ok,
	page,
	ROLE_RUNNER,
	type Role,
} from "../contract";
import { logActivity } from "../db/activity";
import {
	type IdentityState,
	type IdentityVersion as IdentityVersionRow,
	identityStates,
	regenerateIdentity,
	versionByNumber,
	versionByRef,
	versionsBySha,
	versionsFor,
} from "../db/identity";
import {
	agentTemplate,
	client,
	engagement,
	mission,
	rosterEntry,
} from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import {
	templateDispatches,
	templateDispatchTotals,
} from "../db/template-dispatches";
import { type Executor, type Tx, withTx } from "../db/tx";
import type { IdentityRefusal } from "../lib/identity";
import { mergeAllowed } from "../lib/roles";
import { ApiError } from "../middleware/errors";
import { firmRolesIn, notRosterable, rosteredTemplates } from "./firm";
import { entryAccessInput } from "./roster";
import {
	after,
	containsPattern,
	notFound,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof agentTemplate.$inferSelect;

const NO_IDENTITY: IdentityState = {
	version: null,
	stale: false,
	staleInputs: [],
};

function toWire(row: Row, identity: IdentityState): AgentTemplate {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		kind: row.kind,
		roles: row.roles,
		engagementId: row.engagementId,
		waveDefaults: row.waveDefaults,
		title: row.title,
		description: row.description,
		writablePaths: row.writablePaths,
		identityVersion: identity.version?.number ?? null,
		identitySha256: identity.version?.sha256 ?? null,
		identityStale: identity.stale,
		staleInputs: identity.staleInputs,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The rows with their identity state, loaded in one batch. */
async function withIdentity(
	db: Executor,
	rows: Row[],
): Promise<AgentTemplate[]> {
	const states = await identityStates(
		db,
		rows.map((r) => r.id),
	);
	return rows.map((r) => toWire(r, states.get(r.id) ?? NO_IDENTITY));
}

function versionSummary(
	slug: string,
	v: IdentityVersionRow,
): IdentityVersionSummary {
	return {
		ref: `${slug}@v${v.number}`,
		number: v.number,
		sha256: v.sha256,
		identityTokens: v.identityTokens,
		depthTokens: v.depthTokens,
		generatedBy: v.generatedBy,
		createdAt: v.createdAt.toISOString(),
	};
}

function versionWire(slug: string, v: IdentityVersionRow): IdentityVersion {
	return {
		...versionSummary(slug, v),
		agentTemplateId: v.agentTemplateId,
		identityMd: v.identityMd,
		depthMd: v.depthMd,
		inputs: v.inputs,
	};
}

function filtersFor(query: AgentTemplateListQuery): SQL | undefined {
	const pattern = query.q ? containsPattern(query.q) : undefined;
	return and(
		live(agentTemplate),
		pattern
			? or(
					ilike(agentTemplate.slug, pattern),
					ilike(agentTemplate.name, pattern),
				)
			: undefined,
		query.kind ? inArray(agentTemplate.kind, query.kind) : undefined,
		query.role ? arrayOverlaps(agentTemplate.roles, query.role) : undefined,
		query.wave
			? arrayOverlaps(agentTemplate.waveDefaults, query.wave)
			: undefined,
		query.engagementId
			? eq(agentTemplate.engagementId, query.engagementId)
			: undefined,
	);
}

async function liveTemplate(db: Executor, id: string): Promise<Row> {
	const [row] = await db
		.select()
		.from(agentTemplate)
		.where(and(eq(agentTemplate.id, id), live(agentTemplate)));
	if (!row) throw notFound("agent template", id);
	return row;
}

function refusalError(r: IdentityRefusal): ApiError {
	if (r.refused === "identity_role_unsupported") {
		return new ApiError(
			"PRECONDITION_FAILED",
			"Only model roles get an identity; this template holds one that is not",
			{ details: { reason: "identity_role_unsupported" } },
		);
	}
	return new ApiError(
		"PRECONDITION_FAILED",
		`The ${r.file} file would be ${r.tokens} tokens, over the cap of ${r.cap}`,
		{
			details: {
				reason: "identity_over_token_cap",
				file: r.file,
				tokens: r.tokens,
				cap: r.cap,
			},
		},
	);
}

/**
 * Roles no agent may hold: a code role is a pipeline function, never on an
 * agent (ROLES.md, The runtime test), and foundations is the operator's
 * RosterEntry, which covers nothing else. One issue per offending role.
 */
function unassignable(roles: readonly Role[]) {
	const issues: { path: (string | number)[]; message: string }[] = [];
	roles.forEach((r, i) => {
		if (ROLE_RUNNER[r] === "code") {
			issues.push({
				path: ["roles", i],
				message: `${r} is a code role: a pipeline function, never held by an agent`,
			});
		} else if (r === "foundations" && roles.length > 1) {
			issues.push({
				path: ["roles", i],
				message:
					"foundations is the operator's role and is never held with another",
			});
		}
	});
	return issues;
}

/** Refuses a role set no agent may cover, unassignable roles first. */
function checkRoles(roles: readonly Role[]): void {
	const issues = unassignable(roles);
	if (issues.length > 0) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"These roles cannot be held by an agent",
			{ details: { reason: "agent_role_not_assignable", issues } },
		);
	}
	const merge = mergeAllowed(roles);
	if (!merge.ok) {
		throw new ApiError(
			"PRECONDITION_FAILED",
			"Roles merge within one side only, and the fixture merges with nothing",
			{ details: { reason: "agent_roles_cross_sides", sides: merge.sides } },
		);
	}
}

function slugTaken(slug: string): ApiError {
	return new ApiError(
		"CONFLICT",
		`A live agent template already has the slug ${slug}`,
	);
}

/**
 * Two creates racing on one slug both pass the pre-check; the partial
 * unique index stops the second. Postgres aborts the transaction on that
 * error, so it is translated outside withTx, never caught inside it.
 */
function isSlugViolation(err: unknown): boolean {
	for (let e = err; e instanceof Error; e = e.cause) {
		const pg = e as Error & { code?: string; constraint_name?: string };
		if (
			pg.code === "23505" &&
			pg.constraint_name === "agent_template_slug_live_uq"
		)
			return true;
	}
	return false;
}

/**
 * A live engagement of a live client, locked for share so it cannot be
 * removed before the template that names it commits. A closed engagement
 * is allowed: a template outlives the engagement it was made for.
 */
async function requireEngagement(tx: Tx, engagementId: string) {
	const [row] = await tx
		.select({ id: engagement.id })
		.from(engagement)
		.innerJoin(client, and(eq(client.id, engagement.clientId), live(client)))
		.where(and(eq(engagement.id, engagementId), live(engagement)))
		.for("share", { of: engagement });
	if (!row) {
		throw new ApiError("PRECONDITION_FAILED", "The engagement does not exist", {
			details: { reason: "engagement_not_found", engagementId },
		});
	}
}

export function agentTemplateRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(agentTemplateContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(agentTemplate)
					.where(and(filters, after(agentTemplate, query.cursor)))
					.orderBy(desc(agentTemplate.createdAt), desc(agentTemplate.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(agentTemplate)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(
					await withIdentity(db, items),
					nextCursor,
					counted?.total ?? 0,
				),
			};
		},

		get: async ({ params }) => {
			const db = deps.db();
			const [wire] = await withIdentity(db, [
				await liveTemplate(db, params.id),
			]);
			return { status: 200, body: ok(wire as AgentTemplate) };
		},

		dispatches: async ({ params, query }) => {
			const db = deps.db();
			const template = await liveTemplate(db, params.id);
			const filters = { status: query.status, missionId: query.missionId };
			const [{ items, nextCursor }, totals] = await Promise.all([
				templateDispatches(db, template.id, { ...filters, ...query }),
				templateDispatchTotals(db, template.id, filters),
			]);
			return {
				status: 200,
				body: {
					success: true as const,
					data: items,
					meta: { nextCursor, total: totals.total, totals },
				},
			};
		},

		identityVersions: async ({ params }) => {
			const db = deps.db();
			const template = await liveTemplate(db, params.id);
			const versions = await versionsFor(db, template.id);
			return {
				status: 200,
				body: ok(versions.map((v) => versionSummary(template.slug, v))),
			};
		},

		identityVersion: async ({ params }) => {
			const db = deps.db();
			const template = await liveTemplate(db, params.id);
			const v = await versionByNumber(db, template.id, params.number);
			if (!v) {
				throw new ApiError(
					"NOT_FOUND",
					`No identity version ${params.number} for ${template.slug}`,
				);
			}
			return { status: 200, body: ok(versionWire(template.slug, v)) };
		},

		// Logged only when a version is created. The identity in force is the
		// version matching the template's current inputs, so it switches when
		// the inputs change, never here; a 200 (unchanged or reused) changes
		// nothing and leaves no trace.
		regenerateIdentity: async ({ params }, ctx) => {
			const operator = operatorOf(ctx);
			const { slug, result } = await withTx(deps.db(), async (tx) => {
				const template = await liveTemplate(tx, params.id);
				const result = await regenerateIdentity(tx, template.id, {
					clock: deps.clock,
					ids: deps.ids,
					operatorId: operator.id,
				});
				if (!result) throw notFound("agent template", params.id);
				if ("refused" in result) throw refusalError(result);
				if (result.created) {
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "agent_template.identity_regenerated",
						entityType: "agent_template",
						entityId: template.id,
						requestId: ctx.requestId,
						payload: {
							number: result.version.number,
							sha256: result.version.sha256,
						},
					});
				}
				return { slug: template.slug, result };
			});
			const version = versionSummary(slug, result.version);
			return result.created
				? { status: 201, body: ok({ created: true as const, version }) }
				: {
						status: 200,
						body: ok({
							created: false as const,
							reused: result.reused === true,
							version,
						}),
					};
		},

		// Version 1 and no identity: regenerate makes the first one.
		create: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			checkRoles(body.roles);
			try {
				const wire = await withTx(deps.db(), async (tx) => {
					const engagementId = body.engagementId ?? null;
					if (engagementId) await requireEngagement(tx, engagementId);
					const [taken] = await tx
						.select({ id: agentTemplate.id })
						.from(agentTemplate)
						.where(and(eq(agentTemplate.slug, body.slug), live(agentTemplate)))
						.limit(1);
					if (taken) throw slugTaken(body.slug);
					const [created] = await tx
						.insert(agentTemplate)
						.values({
							id: deps.ids.next(),
							slug: body.slug,
							name: body.name,
							kind: body.kind,
							roles: body.roles,
							engagementId,
							waveDefaults: body.waveDefaults,
							title: body.title ?? null,
							description: body.description ?? null,
							writablePaths: body.writablePaths,
							version: 1,
							...stamp(deps.clock),
						})
						.returning();
					if (!created)
						throw new Error("an agent template insert returned no row");
					await logActivity(tx, deps, {
						actorKind: "operator",
						actorUserId: operator.id,
						action: "agent_template.created",
						entityType: "agent_template",
						entityId: created.id,
						engagementId,
						requestId: ctx.requestId,
						payload: { slug: created.slug, version: created.version },
					});
					const [wire] = await withIdentity(tx, [created]);
					return wire as AgentTemplate;
				});
				return { status: 201, body: ok(wire) };
			} catch (err) {
				if (isSlugViolation(err)) throw slugTaken(body.slug);
				throw err;
			}
		},

		// Does not regenerate the identity: a roles or writablePaths change
		// reads stale until the operator regenerates.
		update: async ({ params, body }, ctx) => {
			const operator = operatorOf(ctx);
			if (body.roles) checkRoles(body.roles);
			const wire = await withTx(deps.db(), async (tx) => {
				// Locked FOR UPDATE, so concurrent updates bump the version one at a time.
				const [current] = await tx
					.select({ version: agentTemplate.version })
					.from(agentTemplate)
					.where(and(eq(agentTemplate.id, params.id), live(agentTemplate)))
					.for("update");
				if (!current) throw notFound("agent template", params.id);
				const firm = body.roles ? firmRolesIn(body.roles) : [];
				if (firm.length > 0) {
					// Rosters that can still run; a shipped or archived one never does.
					const entries = await rosteredTemplates(
						tx,
						and(
							eq(rosterEntry.agentTemplateId, params.id),
							inArray(mission.status, ["draft", "active", "halted"]),
						),
					);
					const missions = new Set(entries.map((e) => e.missionId));
					if (entries.length > 0) {
						throw notRosterable(firm, {
							...(missions.size === 1
								? { missionId: entries[0]?.missionId }
								: {}),
							rosterEntryIds: entries.map((e) => e.id),
						});
					}
				}
				const [updated] = await tx
					.update(agentTemplate)
					.set({
						...body,
						version: current.version + 1,
						...touch(deps.clock),
					})
					.where(eq(agentTemplate.id, params.id))
					.returning();
				if (!updated)
					throw new Error("a locked agent template was not updatable");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "agent_template.updated",
					entityType: "agent_template",
					entityId: params.id,
					requestId: ctx.requestId,
					payload: {
						fields: Object.keys(body).sort(),
						version: updated.version,
					},
				});
				const [wire] = await withIdentity(tx, [updated]);
				return wire as AgentTemplate;
			});
			return { status: 200, body: ok(wire) };
		},

		rosterEntries: async ({ params }) => {
			const db = deps.db();
			await liveTemplate(db, params.id);
			const rows = await db
				.select({
					entryId: rosterEntry.id,
					missionId: mission.id,
					type: mission.type,
					status: mission.status,
					sprintN: mission.sprintN,
					engagementId: mission.engagementId,
					active: rosterEntry.active,
					territory: rosterEntry.territory,
				})
				.from(rosterEntry)
				.innerJoin(mission, eq(mission.id, rosterEntry.missionId))
				.where(
					and(
						eq(rosterEntry.agentTemplateId, params.id),
						live(rosterEntry),
						live(mission),
					),
				)
				.orderBy(
					desc(mission.createdAt),
					desc(mission.id),
					asc(rosterEntry.createdAt),
					asc(rosterEntry.id),
				);
			return {
				status: 200,
				body: ok(
					rows.map((r) => ({
						entryId: r.entryId,
						missionId: r.missionId,
						mission: {
							type: r.type,
							status: r.status,
							sprintN: r.sprintN,
							engagementId: r.engagementId,
						},
						active: r.active,
						territory: r.territory,
					})),
				),
			};
		},

		access: async ({ params }) => {
			const db = deps.db();
			const template = await liveTemplate(db, params.id);
			const access = accessFor(
				await entryAccessInput(db, null, template.id, null),
			);
			return { status: 200, body: ok(access) };
		},

		// The slug is unique among live templates (agent_template_slug_live_uq).
		getBySlug: async ({ params }) => {
			const [row] = await deps
				.db()
				.select()
				.from(agentTemplate)
				.where(and(eq(agentTemplate.slug, params.slug), live(agentTemplate)));
			if (!row) {
				throw new ApiError(
					"NOT_FOUND",
					`No agent template with slug ${params.slug}`,
				);
			}
			const [wire] = await withIdentity(deps.db(), [row]);
			return { status: 200, body: ok(wire as AgentTemplate) };
		},
	});
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A recorded agent_version_sha256 must always resolve to its text
 * (DATA-CONTRACTS-V2, CompletionReport), so a sha finds versions of deleted
 * templates too. A ref names a live template's slug.
 */
export function identityVersionRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(identityVersionContract, {
		get: async ({ params }) => {
			const db = deps.db();
			const v = SHA256.test(params.ref)
				? (await versionsBySha(db, params.ref))[0]
				: await versionByRef(db, params.ref);
			if (!v) {
				throw new ApiError("NOT_FOUND", `No identity version ${params.ref}`);
			}
			const [template] = await db
				.select({ slug: agentTemplate.slug })
				.from(agentTemplate)
				.where(eq(agentTemplate.id, v.agentTemplateId));
			if (!template) throw new Error("identity version without its template");
			return { status: 200, body: ok(versionWire(template.slug, v)) };
		},
	});
}
