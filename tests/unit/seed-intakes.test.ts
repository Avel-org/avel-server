import { describe, expect, it } from "vitest";
import { buildSeed, SEED_OPERATOR_ID, seedIds } from "../../src/db/seed/data";
import { devTemplateBookingRead } from "../../src/db/seed/dev-template";
import { DEV_BOOKING_SHA } from "../../src/lib/templates";
import { SEED_RUN_AT } from "./seed-run-at";

// Every seeded client mission has the one approved intake with a repository
// read that its rooms come from (decided 2026-10-21, J): the client's
// repository, which started from the template at the mission's pin.
describe("seed intakes", () => {
	const rows = buildSeed(seedIds(), SEED_RUN_AT);
	const seq = (id: string) => Number(id.slice(-12));

	it("gives each client mission exactly one approved intake, read and approved, and no internal mission any", () => {
		const clients = rows.mission.filter((m) => m.origin === "client");
		expect(clients).toHaveLength(11);
		expect(rows.intake).toHaveLength(clients.length);
		for (const m of rows.mission) {
			const mine = rows.intake.filter((i) => i.missionId === m.id);
			if (m.origin === "internal") {
				expect(mine, m.id).toEqual([]);
				continue;
			}
			expect(mine, m.id).toHaveLength(1);
			const [i] = mine as [(typeof mine)[number]];
			expect(i).toMatchObject({
				engagementId: m.engagementId,
				status: "approved",
				approvedBy: SEED_OPERATOR_ID,
				approvedAt: m.createdAt,
				repoUrl: m.repoUrl,
				repoCommitSha: DEV_BOOKING_SHA,
				derivedCut: m.cut,
				proposedBrief: m.brief,
				deletedAt: m.deletedAt ?? null,
			});
			expect(m.templateVersion).toBe(i.repoCommitSha);
			const readAt = i.repoReadAt as Date;
			expect(readAt.getTime()).toBeLessThan((i.approvedAt as Date).getTime());
			expect((i.createdAt as Date).getTime()).toBeLessThan(readAt.getTime());
		}
	});

	it("derives the cut and its evidence from a real read of the dev fixture", () => {
		const read = devTemplateBookingRead();
		expect(read.commitSha).toBe(DEV_BOOKING_SHA);
		expect(read.cut).toBe("vertical");
		for (const i of rows.intake) {
			expect(i.derivedCutEvidence).toBe(read.cutEvidence);
			expect(i.derivedConventions).toEqual(read.conventions);
			expect(i.derivedBoundaries).toEqual(read.boundaries);
		}
	});

	it("logs intake.approved once per intake, as the seed operator, on its mission", () => {
		const approved = rows.activityLog.filter(
			(a) => a.action === "intake.approved",
		);
		expect(approved).toHaveLength(rows.intake.length);
		for (const i of rows.intake) {
			const [a, ...more] = approved.filter((x) => x.entityId === i.id);
			expect(more, i.id).toEqual([]);
			expect(a).toMatchObject({
				at: i.approvedAt,
				actorKind: "operator",
				actorUserId: SEED_OPERATOR_ID,
				entityType: "intake",
				missionId: i.missionId,
				engagementId: i.engagementId,
				payload: { seed: true, missionId: i.missionId, acknowledged: [] },
			});
		}
	});

	it("draws every intake id, and its log row's, after every other seed id, so no earlier id moved", () => {
		// The gate-ready mission (2026-10-24) is drawn after the intakes, so
		// it is checked apart: its rows hold the ids that follow theirs.
		const gateReady = rows.mission.find(
			(m) =>
				(m.brief as { summary: string }).summary ===
				"Template: open slots. Ready for the gate.",
		)?.id;
		const later = new Set(
			[
				...rows.mission.filter((r) => r.id === gateReady),
				...rows.rosterEntry.filter((r) => r.missionId === gateReady),
				...rows.dispatch.filter((r) => r.missionId === gateReady),
				...rows.completionReport.filter((r) => r.missionId === gateReady),
				...rows.activityLog.filter((r) => r.missionId === gateReady),
			].map((r) => r.id as string),
		);
		const added = new Set([
			...rows.intake.map((i) => i.id as string),
			...rows.activityLog
				.filter((a) => a.action === "intake.approved")
				.map((a) => a.id as string),
		]);
		const others = [
			...rows.client,
			...rows.engagement,
			...rows.connection,
			...rows.agentTemplate,
			...rows.agentIdentityVersion,
			...rows.rosterPreset,
			...rows.playbook,
			...rows.mission,
			...rows.rosterEntry,
			...rows.export,
			...rows.dispatch,
			...rows.completionReport,
			...rows.skillSource,
			...rows.skill,
			...rows.activityLog,
		]
			.map((r) => r.id as string)
			.filter((id) => !added.has(id) && !later.has(id))
			.map(seq);
		const lowest = Math.min(...[...added].map(seq));
		// The other rows hold every id from 1 up to the first intake's, with
		// no gap: an id drawn or skipped earlier would leave one, or move them.
		expect(others.sort((a, b) => a - b)).toEqual(
			Array.from({ length: lowest - 1 }, (_, k) => k + 1),
		);
		// And the intakes and their rows hold the rest, with no gap either.
		expect([...added].map(seq).sort((a, b) => a - b)).toEqual(
			Array.from({ length: added.size }, (_, k) => lowest + k),
		);
		expect(added.size).toBe(2 * rows.intake.length);
		// Between them, one id per export: its manifest's gate run, in no row.
		const after = lowest + added.size + rows.export.length;
		expect([...later].map(seq).sort((a, b) => a - b)).toEqual(
			Array.from({ length: later.size }, (_, k) => after + k),
		);
	});
});
