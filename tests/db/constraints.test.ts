import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db/client";
import {
	agentTemplate,
	completionReport,
	intake,
	mission,
} from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import {
	dispatchValues,
	insertDispatchRow,
	reportValues,
	seedAgent,
} from "./dispatch-fixtures";
import { clock, inRollback, refusal, seedMission } from "./fixtures";

// The CHECKs that turn "required when" sentences in DATA-CONTRACTS-V2 into rules.

describe.skipIf(!process.env.DATABASE_URL)("required-when constraints", () => {
	afterAll(closeDb);

	it("refuses a cut override without a written rationale", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			for (const cutRationale of [null, "  "]) {
				const err = await refusal(tx, (t) =>
					t
						.update(mission)
						.set({ cutSource: "overridden", cutRationale })
						.where(eq(mission.id, missionId)),
				);
				expect(err.constraint_name).toBe("mission_override_has_rationale");
			}
			await tx
				.update(mission)
				.set({
					cutSource: "overridden",
					cutRationale: "Monorepo: feature dirs.",
				})
				.where(eq(mission.id, missionId));
		});
	});

	it("requires halt_reason exactly when a completion report is halted", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId } = await seedMission(tx, ids);
			const agent = await seedAgent(tx, ids, missionId);
			const dispatchId = await insertDispatchRow(
				tx,
				ids,
				dispatchValues(agent, ids, "halted"),
			);
			const { id: _, ...report } = reportValues(ids, {
				id: dispatchId,
				missionId,
				rosterEntryId: agent.entryId,
			});
			for (const bad of [
				{ status: "halted" as const, haltReason: null },
				{ status: "complete" as const, haltReason: "wall_clock" as const },
			]) {
				const err = await refusal(tx, (t) =>
					t
						.insert(completionReport)
						.values({ id: ids.next(), ...report, ...bad }),
				);
				expect(err.constraint_name).toBe(
					"completion_report_halt_reason_iff_halted",
				);
			}
			await tx.insert(completionReport).values({
				id: ids.next(),
				...report,
				status: "halted",
				haltReason: "token_hard_ceiling",
			});
		});
	});

	it("refuses an approved intake without approver, time, and mission", async () => {
		await inRollback(async (tx, ids) => {
			const { engagementId } = await seedMission(tx, ids);
			const err = await refusal(tx, (t) =>
				t.insert(intake).values({
					id: ids.next(),
					engagementId,
					status: "approved",
					sourceMd: "call notes",
					openQuestions: [],
					...stamp(clock),
				}),
			);
			expect(err.constraint_name).toBe("intake_approval_complete");
		});
	});
	it("requires an engagement for a client mission and forbids one for an internal mission", async () => {
		await inRollback(async (tx, ids) => {
			const { missionId, engagementId } = await seedMission(tx, ids);
			const missionRow = {
				type: "full-build",
				brief: {},
				sprintN: 1,
				status: "draft" as const,
				cut: "vertical" as const,
				cutSource: "derived" as const,
				repoUrl: "https://github.com/avel-org/avel-server",
				...stamp(clock),
			};
			for (const bad of [
				{ origin: "client" as const, engagementId: null },
				{ origin: "internal" as const, engagementId },
			]) {
				const err = await refusal(tx, (t) =>
					t.insert(mission).values({ id: ids.next(), ...missionRow, ...bad }),
				);
				expect(err.constraint_name).toBe("mission_engagement_matches_origin");
			}
			// Flipping an existing client mission to internal keeps its engagement: refused.
			const flip = await refusal(tx, (t) =>
				t
					.update(mission)
					.set({ origin: "internal" })
					.where(eq(mission.id, missionId)),
			);
			expect(flip.constraint_name).toBe("mission_engagement_matches_origin");

			const rows = await tx
				.insert(mission)
				.values({
					id: ids.next(),
					...missionRow,
					origin: "internal",
					engagementId: null,
				})
				.returning({ engagementId: mission.engagementId });
			expect(rows).toEqual([{ engagementId: null }]);
		});
	});

	it("bounds an agent's description to 1 to 280 characters, null allowed", async () => {
		await inRollback(async (tx, ids) => {
			const row = (description: string | null) => ({
				id: ids.next(),
				slug: `quill-${ids.next()}`,
				name: "Quill",
				kind: "horizontal" as const,
				roles: ["schema" as const],
				waveDefaults: ["A" as const],
				description,
				writablePaths: ["src/db/**"],
				version: 1,
				...stamp(clock),
			});
			for (const description of ["", "a".repeat(281)]) {
				const err = await refusal(tx, (t) =>
					t.insert(agentTemplate).values(row(description)),
				);
				expect(err.constraint_name).toBe("agent_template_description_length");
			}
			await tx.insert(agentTemplate).values(row(null));
			await tx.insert(agentTemplate).values(row("a".repeat(280)));
		});
	});

	it("bounds an agent's title to 1 to 60 characters once trimmed, null allowed", async () => {
		await inRollback(async (tx, ids) => {
			const row = (title: string | null) => ({
				id: ids.next(),
				slug: `quill-${ids.next()}`,
				name: "Quill",
				kind: "horizontal" as const,
				roles: ["schema" as const],
				waveDefaults: ["A" as const],
				title,
				writablePaths: ["src/db/**"],
				version: 1,
				...stamp(clock),
			});
			for (const title of ["", "   ", "a".repeat(61), ` ${"a".repeat(61)} `]) {
				const err = await refusal(tx, (t) =>
					t.insert(agentTemplate).values(row(title)),
				);
				expect(err.constraint_name, JSON.stringify(title)).toBe(
					"agent_template_title_length",
				);
			}
			await tx.insert(agentTemplate).values(row(null));
			await tx.insert(agentTemplate).values(row("a".repeat(60)));
			await tx.insert(agentTemplate).values(row(` ${"a".repeat(60)} `));
		});
	});
});
