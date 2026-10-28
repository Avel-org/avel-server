import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, sql } from "drizzle-orm";
import { ok, page, type RepoPolicy, repoPolicyContract } from "../contract";
import { logActivity } from "../db/activity";
import { repoPolicyUrl } from "../db/repo-policy";
import { repoPolicy } from "../db/schema";
import { live, stamp, touch } from "../db/schema/columns";
import { withTx } from "../db/tx";
import { ApiError } from "../middleware/errors";
import { ownerRepo } from "../rooms/sources";
import {
	after,
	operatorOf,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof repoPolicy.$inferSelect;

function toWire(row: Row): RepoPolicy {
	return {
		id: row.id,
		repoUrl: row.repoUrl,
		label: row.label,
		allowDirectPushToDefault: row.allowDirectPushToDefault,
		defaultTarget: row.defaultTarget,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * RepoPolicy reads and writes, operator only (module 11, 2026-10-24). A
 * repository with no live row allows no direct push to its default branch,
 * so the list's empty state is the safe one. Setting a policy creates or
 * updates the one live row for that repository, keyed by repoPolicyUrl.
 */
export function repoPolicyRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(repoPolicyContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(repoPolicy)
					.where(and(live(repoPolicy), after(repoPolicy, query.cursor)))
					.orderBy(desc(repoPolicy.createdAt), desc(repoPolicy.id))
					.limit(query.limit + 1),
				db
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(repoPolicy)
					.where(live(repoPolicy)),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(items.map(toWire), nextCursor, counted?.n ?? 0),
			};
		},

		set: async ({ body }, ctx) => {
			const operator = operatorOf(ctx);
			const named = ownerRepo(body.repoUrl);
			if (!named) {
				throw new ApiError(
					"VALIDATION_FAILED",
					"A GitHub repository: https://github.com/owner/repo",
				);
			}
			const repoUrl = repoPolicyUrl(named.owner, named.repo);
			const row = await withTx(deps.db(), async (tx) => {
				// One writer per repository at a time, so two first sets cannot
				// both insert a live row.
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${`repo_policy:${repoUrl}`}))`,
				);
				const [prior] = await tx
					.select()
					.from(repoPolicy)
					.where(and(eq(repoPolicy.repoUrl, repoUrl), live(repoPolicy)));
				// Only turning it on is the deliberate act. Read under the lock,
				// so two sets cannot both see it off and skip the confirmation.
				if (
					body.allowDirectPushToDefault &&
					!prior?.allowDirectPushToDefault &&
					body.confirmDirectPush !== true
				) {
					throw new ApiError(
						"PRECONDITION_FAILED",
						"Allowing a direct push to the default branch needs confirmDirectPush: true",
						{ details: { reason: "direct_push_unconfirmed" } },
					);
				}
				const values = {
					label: body.label === undefined ? (prior?.label ?? null) : body.label,
					allowDirectPushToDefault: body.allowDirectPushToDefault,
					defaultTarget:
						body.defaultTarget === undefined
							? (prior?.defaultTarget ?? null)
							: body.defaultTarget,
				};
				const [written] = prior
					? await tx
							.update(repoPolicy)
							.set({ ...values, ...touch(deps.clock) })
							.where(eq(repoPolicy.id, prior.id))
							.returning()
					: await tx
							.insert(repoPolicy)
							.values({
								id: deps.ids.next(),
								repoUrl,
								...values,
								deletedAt: null,
								...stamp(deps.clock),
							})
							.returning();
				if (!written) throw new Error("repo_policy write returned no row");
				await logActivity(tx, deps, {
					actorKind: "operator",
					actorUserId: operator.id,
					action: "repo_policy.set",
					entityType: "repo_policy",
					entityId: written.id,
					requestId: ctx.requestId,
					payload: {
						repoUrl,
						allowDirectPushToDefault: written.allowDirectPushToDefault,
						defaultTarget: written.defaultTarget,
						was: prior
							? {
									allowDirectPushToDefault: prior.allowDirectPushToDefault,
									defaultTarget: prior.defaultTarget,
								}
							: null,
					},
				});
				return written;
			});
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
