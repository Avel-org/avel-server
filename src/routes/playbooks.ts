import { tsr } from "@ts-rest/serverless/fetch";
import { and, desc, eq, ilike, type SQL, sql } from "drizzle-orm";
import {
	ok,
	type Playbook,
	type PlaybookListQuery,
	page,
	playbookContract,
} from "../contract";
import { playbook } from "../db/schema";
import { live } from "../db/schema/columns";
import { ApiError } from "../middleware/errors";
import {
	after,
	containsPattern,
	type RequestContext,
	type RouteDeps,
	toPage,
} from "./shared";

type Row = typeof playbook.$inferSelect;

function toWire(row: Row): Playbook {
	return {
		id: row.id,
		missionType: row.missionType,
		name: row.name,
		wavesApplicable: row.wavesApplicable,
		gates: row.gates.map((g) => ({ gate: g.gate, policy: g.policy })),
		deliverable: row.deliverable,
		requiredFields: row.requiredFields,
		defaultPresetId: row.defaultPresetId,
		version: row.version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function filtersFor(query: PlaybookListQuery): SQL | undefined {
	return and(
		live(playbook),
		query.q ? ilike(playbook.name, containsPattern(query.q)) : undefined,
	);
}

export function playbookRoutes(deps: RouteDeps) {
	return tsr.platformContext<RequestContext>().router(playbookContract, {
		list: async ({ query }) => {
			const db = deps.db();
			const filters = filtersFor(query);
			const [rows, [counted]] = await Promise.all([
				db
					.select()
					.from(playbook)
					.where(and(filters, after(playbook, query.cursor)))
					.orderBy(desc(playbook.createdAt), desc(playbook.id))
					.limit(query.limit + 1),
				db
					.select({ total: sql<number>`count(*)`.mapWith(Number) })
					.from(playbook)
					.where(filters),
			]);
			const { items, nextCursor } = toPage(rows, query.limit);
			return {
				status: 200,
				body: page(items.map(toWire), nextCursor, counted?.total ?? 0),
			};
		},

		getForType: async ({ params }) => {
			// mission_type is unique among live playbooks (playbook_mission_type_live_uq).
			const [row] = await deps
				.db()
				.select()
				.from(playbook)
				.where(
					and(eq(playbook.missionType, params.missionType), live(playbook)),
				);
			if (!row)
				throw new ApiError(
					"NOT_FOUND",
					`No playbook for mission type ${params.missionType}`,
				);
			return { status: 200, body: ok(toWire(row)) };
		},
	});
}
