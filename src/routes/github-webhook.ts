import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { exportTable, mission } from "../db/schema";
import { withTx } from "../db/tx";
import type { BlastRadius } from "../lib/export/delivery";
import { ApiError } from "../middleware/errors";
import { exportLifecycle } from "./exports";
import type { RouteDeps } from "./shared";

/** The header GitHub signs a delivery with: sha256=<hex HMAC of the raw body>. */
const SIGNATURE = "x-hub-signature-256";

/** The fields of a pull_request event this route reads; everything else is ignored. */
const pullRequestEvent = z.object({
	action: z.string(),
	pull_request: z.object({
		number: z.number().int().positive(),
		html_url: z.string(),
		merged: z.boolean().nullable().optional(),
		head: z.object({ ref: z.string(), sha: z.string() }),
	}),
	repository: z.object({ full_name: z.string() }),
});

/** Whether `signature` is the body's HMAC under `secret`, compared in constant time. */
export function signatureMatches(
	secret: string,
	body: string,
	signature: string | undefined,
): boolean {
	if (!signature?.startsWith("sha256=")) return false;
	const want = Buffer.from(
		`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
	);
	const got = Buffer.from(signature);
	return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * POST /api/webhooks/github (DATA-CONTRACTS-V2.md, Non-contract routes): it
 * receives and does not envelope. No session reaches it; GitHub signs each
 * delivery with GITHUB_WEBHOOK_SECRET, and an unsigned or wrongly signed
 * one is 401. With no secret configured the route does not exist (404).
 *
 * A closed pull request moves the export that opened it from pr-open to
 * done when it merged and to closed when it did not, as the system. The
 * export is found by its PR number, its branch and its repository, so a
 * PR AVEL did not open moves nothing. Every other event, and a replayed
 * delivery, answers 204 and changes nothing.
 */
export function githubWebhookRoute(
	deps: RouteDeps & { secret: string | null },
) {
	const { recordPullRequest } = exportLifecycle(deps);
	return async (ctx: Context) => {
		if (deps.secret === null) {
			throw new ApiError("NOT_FOUND", "No route POST /api/webhooks/github");
		}
		const raw = await ctx.req.text();
		if (!signatureMatches(deps.secret, raw, ctx.req.header(SIGNATURE))) {
			throw new ApiError(
				"UNAUTHENTICATED",
				"The delivery is not signed with this server's webhook secret",
			);
		}
		if (ctx.req.header("x-github-event") !== "pull_request") {
			return ctx.body(null, 204);
		}
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			throw new ApiError("VALIDATION_FAILED", "The delivery is not JSON");
		}
		const event = pullRequestEvent.safeParse(json);
		if (!event.success) {
			throw new ApiError(
				"VALIDATION_FAILED",
				"The delivery is not a pull_request event",
			);
		}
		const { action, pull_request: pr, repository } = event.data;
		if (action !== "closed") return ctx.body(null, 204);

		const requestId = ctx.get("requestId") as string;
		await withTx(deps.db(), async (tx) => {
			const rows = await tx
				.select({ row: exportTable, engagementId: mission.engagementId })
				.from(exportTable)
				.innerJoin(mission, eq(mission.id, exportTable.missionId))
				.where(
					and(
						eq(exportTable.targetKind, "github_pr"),
						eq(exportTable.dryRun, false),
						eq(exportTable.prNumber, pr.number),
						eq(exportTable.prHeadRef, pr.head.ref),
					),
				);
			const named = repository.full_name.toLowerCase();
			for (const { row, engagementId } of rows) {
				const target = (row.blastRadius as BlastRadius | null)?.target;
				if (
					!target ||
					`${target.owner}/${target.repo}`.toLowerCase() !== named
				) {
					continue;
				}
				await recordPullRequest(
					tx,
					{ requestId, operator: undefined },
					row,
					{
						number: pr.number,
						url: pr.html_url,
						branch: pr.head.ref,
						commitSha: row.prCommitSha ?? pr.head.sha,
						state: pr.merged ? "merged" : "closed",
					},
					engagementId,
					"system",
				);
			}
		});
		return ctx.body(null, 204);
	};
}
