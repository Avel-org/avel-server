import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { skill, skillSource } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import type { Tx } from "../../src/db/tx";
import type { IdGenerator } from "../../src/lib/ids";
import { clock, inRollback, refusal } from "./fixtures";

async function seedSource(tx: Tx, ids: IdGenerator) {
	const sourceId = ids.next();
	await tx.insert(skillSource).values({
		id: sourceId,
		name: "AVEL",
		kind: "internal",
		...stamp(clock),
	});
	return sourceId;
}

function skillRow(ids: IdGenerator, sourceId: string) {
	return {
		id: ids.next(),
		slug: `skill-${ids.next()}`,
		name: "Skill",
		description: "One sentence.",
		contentMd: "# Skill",
		layer: "stack" as const,
		recommendedFor: ["domain" as const],
		sourceId,
		contentSha256: "0".repeat(64),
		status: "draft" as const,
		version: 1,
		...stamp(clock),
	};
}

const io = { reads: "large" as const, returns: "small" as const };

describe.skipIf(!process.env.DATABASE_URL)("skill type CHECK", () => {
	afterAll(closeDb);

	it("refuses a capability without grants or without io_shape", async () => {
		await inRollback(async (tx, ids) => {
			const sourceId = await seedSource(tx, ids);
			for (const missing of [
				{ grants: null, ioShape: io },
				{ grants: ["browser"], ioShape: null },
				{ grants: null, ioShape: null },
			]) {
				const err = await refusal(tx, (t) =>
					t.insert(skill).values({
						...skillRow(ids, sourceId),
						type: "capability",
						...missing,
					}),
				);
				expect(err.constraint_name).toBe("skill_capability_fields");
			}
		});
	});

	it("refuses a knowledge skill that carries grants or io_shape", async () => {
		await inRollback(async (tx, ids) => {
			const sourceId = await seedSource(tx, ids);
			for (const extra of [
				{ grants: ["browser"], ioShape: null },
				{ grants: null, ioShape: io },
				{ grants: ["browser"], ioShape: io },
			]) {
				const err = await refusal(tx, (t) =>
					t.insert(skill).values({
						...skillRow(ids, sourceId),
						type: "knowledge",
						...extra,
					}),
				);
				expect(err.constraint_name).toBe("skill_capability_fields");
			}
		});
	});

	it("accepts a capability with both, and a knowledge skill with neither", async () => {
		await inRollback(async (tx, ids) => {
			const sourceId = await seedSource(tx, ids);
			const rows = await tx
				.insert(skill)
				.values([
					{
						...skillRow(ids, sourceId),
						type: "capability",
						grants: ["browser"],
						ioShape: io,
					},
					{ ...skillRow(ids, sourceId), type: "knowledge" },
				])
				.returning({ type: skill.type });
			expect(rows.map((r) => r.type)).toEqual(["capability", "knowledge"]);
		});
	});
});
