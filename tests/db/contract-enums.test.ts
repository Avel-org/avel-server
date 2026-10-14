import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
	activityAction,
	activityEntityType,
	COMPLETION_STATUSES,
	HALT_REASONS,
	VERSION_SOURCES,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { inRollback } from "./fixtures";

/**
 * The migrated database's enums, label for label, against the contract. The
 * schema tests compare the contract with the Drizzle pgEnums; this compares
 * it with what the migrations actually built.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"contract enums in the database",
	() => {
		afterAll(closeDb);

		const cases: Array<[string, readonly string[]]> = [
			["activity_action", activityAction.options],
			["activity_entity_type", activityEntityType.options],
			["halt_reason", HALT_REASONS],
			["completion_status", COMPLETION_STATUSES],
			["version_source", VERSION_SOURCES],
		];

		for (const [type, values] of cases) {
			it(`${type} holds exactly the contract's values, in order`, async () => {
				await inRollback(async (tx) => {
					const rows = await tx.execute<{ label: string }>(
						sql`select enumlabel as label from pg_enum
						where enumtypid = ${type}::regtype order by enumsortorder`,
					);
					expect(rows.map((r) => r.label)).toEqual([...values]);
				});
			});
		}
	},
);
