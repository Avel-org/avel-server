import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import { completionReport } from "../../src/db/schema";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
	seedAgent,
} from "./dispatch-fixtures";
import { inRollback, refusal, seedMission } from "./fixtures";

// completion_report.result_commit_sha (drizzle/0035): the dispatch's commit,
// which only an agent's own report carries. The sixth freeze exception.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe.skipIf(!process.env.DATABASE_URL)("a report's result commit", () => {
	afterAll(closeDb);

	async function reportFor(
		tx: Parameters<Parameters<typeof inRollback>[0]>[0],
		ids: Parameters<Parameters<typeof inRollback>[0]>[1],
	) {
		const { missionId } = await seedMission(tx, ids);
		const agent = await seedAgent(tx, ids, missionId);
		const dispatchId = await insertDispatchRow(
			tx,
			ids,
			dispatchValues(agent, ids, "complete"),
		);
		return reportValues(ids, {
			id: dispatchId,
			missionId,
			rosterEntryId: agent.entryId,
		});
	}

	it("is a 40-character lowercase hex sha on an agent's report, or null", async () => {
		await inRollback(async (tx, ids) => {
			const report = await reportFor(tx, ids);
			for (const bad of [
				COMMIT.toUpperCase(),
				COMMIT.slice(1),
				`${COMMIT}0`,
				"",
				"main",
			]) {
				const err = await refusal(tx, (t) =>
					t
						.insert(completionReport)
						.values({ ...report, filedBy: "agent", resultCommitSha: bad }),
				);
				expect(err.constraint_name, bad).toBe(
					"completion_report_result_commit_sha_hex",
				);
			}
			await tx
				.insert(completionReport)
				.values({ ...report, filedBy: "agent", resultCommitSha: COMMIT });
		});
	});

	it("is never on a report the system filed", async () => {
		await inRollback(async (tx, ids) => {
			const report = await reportFor(tx, ids);
			const err = await refusal(tx, (t) =>
				t
					.insert(completionReport)
					.values({ ...report, filedBy: "system", resultCommitSha: COMMIT }),
			);
			expect(err.constraint_name).toBe(
				"completion_report_system_has_no_commit",
			);
			await tx
				.insert(completionReport)
				.values({ ...report, filedBy: "system", resultCommitSha: null });
		});
	});

	it("may be null on an agent's report", async () => {
		await inRollback(async (tx, ids) => {
			const report = await reportFor(tx, ids);
			await tx
				.insert(completionReport)
				.values({ ...report, filedBy: "agent", resultCommitSha: null });
		});
	});
});
