import { describe, expect, it } from "vitest";
import { DISPATCH_STATUSES, HALT_REASONS } from "../../src/contract";
import { buildSeed, SEED_OPERATOR_ID, seedIds } from "../../src/db/seed/data";
import { checkPlan } from "../../src/lib/plan-check";
import { PRICE_VERSION } from "../../src/lib/prices";
import { skillsSha256 } from "../../src/runner/skills";
import { SEED_RUN_AT } from "./seed-run-at";

// Module 6's preview (BE lead, 2026-10-13): one active client mission with a
// dispatch in every state, and one halted at its spend ceiling.
describe("seed dispatches", () => {
	const rows = buildSeed(seedIds(), SEED_RUN_AT);
	const missionOf = (repo: string, sprint: number) => {
		const m = rows.mission.find(
			(x) => x.repoUrl === `https://github.com/${repo}` && x.sprintN === sprint,
		);
		if (!m) throw new Error(`no mission ${repo} ${sprint}`);
		return m;
	};
	const active = missionOf("halvorsen-pike/billing", 2);
	const capped = missionOf("brightwater-clinics/booking", 3);
	const dispatchesOf = (missionId: string) =>
		rows.dispatch.filter((d) => d.missionId === missionId);
	const reportOf = (dispatchId: string) =>
		rows.completionReport.filter((r) => r.dispatchId === dispatchId);
	const entryOf = (id: string) => {
		const e = rows.rosterEntry.find((x) => x.id === id);
		if (!e) throw new Error(`no entry ${id}`);
		return e;
	};
	const spend = (missionId: string) =>
		dispatchesOf(missionId).reduce(
			(sum, d) => sum + Math.round(Number(d.spendUsd) * 1_000_000),
			0,
		) / 1_000_000;

	it("puts one dispatch in every state on the active mission, and halts the other at its ceiling", () => {
		expect(active.status).toBe("active");
		expect(capped.status).toBe("halted");
		const states = dispatchesOf(active.id).map(
			(d) => `${d.status}${d.haltReason ? `:${d.haltReason}` : ""}`,
		);
		expect(states.sort()).toEqual(
			[
				...DISPATCH_STATUSES.filter((s) => s !== "halted"),
				"halted:token_hard_ceiling",
				"halted:wall_clock",
				"halted:operator",
			].sort(),
		);
		expect(
			dispatchesOf(capped.id).map((d) => [d.status, d.haltReason]),
		).toEqual([["halted", "spend_ceiling"]]);
		// Every halt reason appears once across the two missions.
		expect(
			rows.dispatch
				.map((d) => d.haltReason)
				.filter((r) => r !== null)
				.sort(),
		).toEqual([...HALT_REASONS].sort());
	});

	it("readies both missions as start would have", () => {
		for (const m of [active, capped]) {
			expect(m.origin).toBe("client");
			expect(checkPlan(m.brief), m.repoUrl).toEqual([]);
			expect(m.spendCeilingUsd).not.toBeNull();
			const entries = rows.rosterEntry.filter(
				(e) => e.missionId === m.id && e.active,
			);
			for (const e of entries) {
				expect(e.estimatedTokens, e.id).not.toBeNull();
			}
			const engagement = rows.engagement.find((g) => g.id === m.engagementId);
			expect(engagement?.status).toBe("active");
		}
	});

	it("spends about 90% of the active mission's ceiling, and all of the halted one's", () => {
		const ratio = spend(active.id) / Number(active.spendCeilingUsd);
		expect(ratio).toBeGreaterThanOrEqual(0.85);
		expect(ratio).toBeLessThan(0.95);
		expect(spend(capped.id)).toBeGreaterThanOrEqual(
			Number(capped.spendCeilingUsd),
		);
	});

	it("copies the entry's estimate and ceilings, and keeps the token split summed", () => {
		for (const d of rows.dispatch) {
			const e = entryOf(d.rosterEntryId);
			expect(e.missionId).toBe(d.missionId);
			expect([
				d.estimatedTokens,
				d.tokenSoftCeiling,
				d.tokenHardCeiling,
			]).toEqual([e.estimatedTokens, e.tokenSoftCeiling, e.tokenHardCeiling]);
			expect(d.tokensUsed).toBe(
				d.tokensIn + d.tokensOut + d.cacheReadTokens + d.cacheWriteTokens,
			);
			expect(d.softCeilingCrossed, d.id).toBe(
				d.tokensUsed >= d.tokenSoftCeiling,
			);
			if (d.haltReason === "token_hard_ceiling") {
				expect(d.tokensUsed).toBeGreaterThanOrEqual(d.tokenHardCeiling);
			}
		}
	});

	it("freezes the template's current identity on every started dispatch", () => {
		for (const d of rows.dispatch) {
			if (d.status === "queued") {
				expect([
					d.agentIdentityVersionId,
					d.agentVersionSha256,
					d.skillsSha256,
					d.model,
					d.priceVersion,
					d.startedAt,
				]).toEqual([null, null, null, null, null, null]);
				continue;
			}
			const templateId = entryOf(d.rosterEntryId).agentTemplateId;
			const versions = rows.agentIdentityVersion.filter(
				(v) => v.agentTemplateId === templateId,
			);
			const current = versions.reduce((a, v) => (v.number > a.number ? v : a));
			expect(d.agentIdentityVersionId).toBe(current.id);
			expect(d.agentVersionSha256).toBe(current.sha256);
			// No mission here attaches a skill: the empty set's hash, as start freezes it.
			expect(d.skillsSha256).toBe(skillsSha256([]));
			expect(d.model).toBe("fake-harness");
			expect(d.priceVersion).toBe(PRICE_VERSION);
		}
	});

	it("times only the running dispatch from the run, inside its wall clock", () => {
		const running = rows.dispatch.filter((d) => d.status === "running");
		expect(running).toHaveLength(1);
		const [d] = running as [(typeof running)[number]];
		const minutesBefore = (t: Date | null | undefined) =>
			t == null ? null : (SEED_RUN_AT.getTime() - t.getTime()) / 60_000;
		expect(minutesBefore(d.createdAt)).toBe(30);
		expect(minutesBefore(d.startedAt)).toBe(25);
		expect(minutesBefore(d.updatedAt)).toBe(10);
		expect(minutesBefore(d.startedAt)).toBeLessThan(d.wallClockMinutes);
		// Every other row stays on the fixed clock, whenever the seed runs.
		const later = buildSeed(
			seedIds(),
			new Date(SEED_RUN_AT.getTime() + 86_400_000),
		);
		const fixed = (r: typeof rows) => ({
			...r,
			dispatch: r.dispatch.filter((x) => x.status !== "running"),
			activityLog: r.activityLog.filter((a) => a.entityId !== d.id),
		});
		expect(fixed(later)).toEqual(fixed(rows));
		const moved = later.activityLog.filter((a) => a.entityId === d.id);
		expect(moved.map((a) => a.action)).toEqual([
			"dispatch.created",
			"dispatch.started",
			"dispatch.soft_ceiling_crossed",
		]);
		expect(moved.map((a) => minutesBefore(a.at))).toEqual([
			30 - 1440,
			25 - 1440,
			10 - 1440,
		]);
	});

	it("gives only the running dispatch a token hash", () => {
		for (const d of rows.dispatch) {
			if (d.status === "running") {
				expect(d.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
			} else {
				expect(d.tokenSha256, d.status).toBeNull();
			}
		}
	});

	it("closes every ended dispatch with one report, filed by the agent only for complete or blocked", () => {
		for (const d of rows.dispatch) {
			const reports = reportOf(d.id);
			if (d.closedAt === null) {
				expect(reports, d.status).toEqual([]);
				continue;
			}
			expect(reports).toHaveLength(1);
			const r = reports[0];
			expect(r?.filedBy, d.status).toBe(
				d.status === "complete" || d.status === "blocked" ? "agent" : "system",
			);
			expect(r).toMatchObject({
				status: d.status,
				haltReason: d.haltReason,
				softCeilingCrossed: d.softCeilingCrossed,
				actualTokens: d.tokensUsed,
				agentVersionSha256: d.agentVersionSha256,
				skillsSha256: d.skillsSha256,
				model: d.model,
				missionId: d.missionId,
				rosterEntryId: d.rosterEntryId,
				createdAt: d.closedAt,
			});
		}
		const complete = rows.dispatch.find((d) => d.status === "complete");
		const full = reportOf(complete?.id ?? "")[0];
		expect(full?.artifactsRead.length).toBeGreaterThan(0);
		expect(full?.artifactsWritten.length).toBeGreaterThan(0);
		expect(full?.filesTouched).toBeGreaterThan(0);
		expect(full?.fileTypesTouched.length).toBeGreaterThan(0);
		expect(full?.blockers).toEqual([]);
		const blocked = rows.dispatch.find((d) => d.status === "blocked");
		const gaps = reportOf(blocked?.id ?? "")[0]?.blockers ?? [];
		expect(gaps.map((b) => b.provisioning_gap).sort()).toEqual([false, true]);
	});

	it("records one edge mismatch, against what the producer's report wrote", () => {
		const mismatches = rows.completionReport.flatMap((r) =>
			r.edgeMismatches.map((m) => ({ consumer: r, m })),
		);
		expect(mismatches).toHaveLength(1);
		const [{ consumer, m }] = mismatches as [(typeof mismatches)[number]];
		const producer = reportOf(m.producer_dispatch_id)[0];
		expect(producer?.missionId).toBe(consumer.missionId);
		expect(
			producer?.artifactsWritten.find((a) => a.path === m.path)?.sha256,
		).toBe(m.written_sha256);
		expect(consumer.artifactsRead.find((a) => a.path === m.path)?.sha256).toBe(
			m.read_sha256,
		);
		expect(m.read_sha256).not.toBe(m.written_sha256);
	});

	it("logs each dispatch's life, as the actor that did each step", () => {
		const rowsFor = (entityId: string, action: string) =>
			rows.activityLog.filter(
				(a) => a.entityId === entityId && a.action === action,
			);
		for (const d of rows.dispatch) {
			const system = {
				actorKind: "system",
				actorUserId: null,
				actorRosterEntryId: null,
			};
			const operator = {
				actorKind: "operator",
				actorUserId: SEED_OPERATOR_ID,
				actorRosterEntryId: null,
			};
			const once = (action: string, when: Date | null | undefined) => {
				const found = rowsFor(d.id, action);
				if (when === null || when === undefined) {
					expect(found, `${d.status} ${action}`).toEqual([]);
					return undefined;
				}
				expect(found, `${d.status} ${action}`).toHaveLength(1);
				expect(found[0]?.at).toEqual(when);
				expect(found[0]?.missionId).toBe(d.missionId);
				return found[0];
			};
			expect(once("dispatch.created", d.createdAt)).toMatchObject(operator);
			const started = once("dispatch.started", d.startedAt);
			if (started) expect(started).toMatchObject(operator);
			const crossed = rowsFor(d.id, "dispatch.soft_ceiling_crossed");
			expect(crossed.length, d.id).toBe(d.softCeilingCrossed ? 1 : 0);
			for (const c of crossed) expect(c).toMatchObject(system);
			const halted = once(
				"dispatch.halted",
				d.status === "halted" ? d.closedAt : null,
			);
			if (halted) {
				// The operator's own halt is the operator's; the rest the runner's.
				expect(halted).toMatchObject(
					d.haltReason === "operator" ? operator : system,
				);
				expect(halted.payload).toMatchObject({ reason: d.haltReason });
			}
			const report = reportOf(d.id)[0];
			const filer =
				report?.filedBy === "agent"
					? { actorKind: "agent", actorRosterEntryId: d.rosterEntryId }
					: system;
			const closed = once("dispatch.closed", d.closedAt);
			if (closed) expect(closed).toMatchObject(filer);
			if (report) {
				const filed = rowsFor(report.id, "completion_report.filed");
				expect(filed).toHaveLength(1);
				expect(filed[0]).toMatchObject({
					...filer,
					entityType: "completion_report",
					at: report.createdAt,
				});
			}
		}
	});

	it("names the seed operator for operator acts, the runner for its own, and agents for theirs", () => {
		const split = { operator: 0, system: 0, agent: 0, canon: 0 };
		for (const a of rows.activityLog) split[a.actorKind] += 1;
		// 89: Canon's identity_regenerated row (2026-10-19) is the seed operator's.
		// 100: plus the eleven intake.approved rows, one per client mission
		// (2026-10-21).
		expect(split).toEqual({ operator: 100, system: 24, agent: 4, canon: 0 });
		expect(rows.activityLog).toHaveLength(128);
		for (const a of rows.activityLog) {
			expect(a.actorUserId, a.action).toBe(
				a.actorKind === "operator" ? SEED_OPERATOR_ID : null,
			);
		}
		// The system rows are exactly the runner's acts and export status moves.
		const runnerActions = rows.activityLog
			.filter((a) => a.actorKind === "system")
			.map((a) => a.action);
		expect(new Set(runnerActions)).toEqual(
			new Set([
				"export.status_changed",
				"dispatch.soft_ceiling_crossed",
				"dispatch.halted",
				"completion_report.filed",
				"dispatch.closed",
				"mission.status_changed",
			]),
		);
		expect(
			rows.activityLog.filter(
				(a) =>
					a.actorKind === "system" && a.action === "mission.status_changed",
			),
		).toHaveLength(1);
		expect(
			rows.activityLog.filter((a) => a.action === "export.status_changed"),
		).toHaveLength(7);
		expect(
			rows.activityLog
				.filter((a) => a.action === "export.status_changed")
				.every((a) => a.actorKind === "system"),
		).toBe(true);
	});

	it("seeds one operator user that can never sign in or match the allowlist", () => {
		expect(rows.user).toEqual([
			{
				id: SEED_OPERATOR_ID,
				name: "Seed operator",
				email: "seed-operator@example.com",
				emailVerified: false,
				image: null,
				githubId: "0",
				githubLogin: "seed-operator",
				createdAt: expect.any(Date),
				updatedAt: expect.any(Date),
			},
		]);
	});

	it("halts the capped mission at the moment its dispatch hit the ceiling, as the system", () => {
		const changes = rows.activityLog.filter(
			(a) => a.entityId === capped.id && a.action === "mission.status_changed",
		);
		const halt = changes.find(
			(a) => (a.payload as { to?: string }).to === "halted",
		);
		expect(halt).toMatchObject({
			actorKind: "system",
			payload: { from: "active", to: "halted" },
		});
		expect(halt?.at).toEqual(dispatchesOf(capped.id)[0]?.closedAt);
		const activation = rows.activityLog.find(
			(a) =>
				a.entityId === active.id &&
				a.action === "mission.status_changed" &&
				(a.payload as { to?: string }).to === "active",
		);
		expect(activation?.payload).toMatchObject({ from: "draft", to: "active" });
	});
});
