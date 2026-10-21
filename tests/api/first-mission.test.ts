import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	activityListEnvelope,
	clientSchema,
	connectionSchema,
	dispatch as dispatchWire,
	engagementSchema,
	gateRun as gateRunSchema,
	intakeSchema,
	missionPlanSchema,
	successEnvelope,
} from "../../src/contract";
import { closeDb } from "../../src/db/client";
import { agentTemplate } from "../../src/db/schema";
import { stamp } from "../../src/db/schema/columns";
import { buildSeed, seedIds as seedRowIds } from "../../src/db/seed/data";
import { buildDevTemplateBooking } from "../../src/db/seed/dev-template";
import { DEV_BOOKING_SHA } from "../../src/lib/templates";
import { worktreeRooms } from "../../src/rooms/provider";
import { localSources } from "../../src/rooms/sources";
import { writeTool } from "../../src/rooms/tools";
import { FakeHarness } from "../../src/runner/harness";
import { gitIn, removeDir, tempDir } from "../unit/git-fixtures";
import { fixtureRepos, snapshotOfCommit } from "../unit/repo-fixtures";
import { SEED_RUN_AT } from "../unit/seed-run-at";
import { bearer, seedIds } from "./agent-fixtures";
import { type ApiHarness, clock, withApi } from "./support";

// One mission through every built module, over the HTTP API the way
// avel-web and an agent call it: client, engagement, intake, repo read,
// approval, plan, roster, start, dispatch in a real worktree room, the
// agent's report, the gate, and the activity chain. Direct inserts appear
// only where no route exists, each marked GAP.
//
// It is a client mission that started from the template: the client's
// repository, meridian-co/app, is a clone whose commit is the
// template-booking dev fixture's. The intake reads that commit, and the
// rooms open on it from the client's clone (decided 2026-10-21, J). The
// plan's template pin is only the record of where the code came from.

const base = tempDir("first-mission");
afterAll(async () => {
	removeDir(base);
	await closeDb();
});

const sources = path.join(base, "sources");
const REPO = "https://github.com/meridian-co/app";
const clientClone = path.join(sources, "repos", "meridian-co", "app");
const SLOTS = "src/features/scheduling/slots.ts";

const BRIEF = {
	summary: "Online booking for a small shop",
	requirements: [{ id: "R1", text: "A customer sees the open slots" }],
	acceptanceCriteria: [
		{ id: "AC1", requirementId: "R1", text: "The slot list is computed" },
	],
};

const PLAN = {
	...BRIEF,
	modules: [
		{
			id: "M1",
			name: "Scheduling",
			requirementIds: ["R1"],
			reads: ["src/features/scheduling/**"],
		},
	],
	checks: [
		{
			id: "CK1",
			requirementId: "R1",
			kind: "file_exists" as const,
			path: SLOTS,
			note: "The slot module exists",
		},
		{
			id: "CK2",
			requirementId: "R1",
			kind: "test" as const,
			command: "pnpm test",
			note: "Needs a runner, so it cannot run yet",
		},
	],
};

// The seed's playbook, so the test judges what avel_dev judges.
const booking = buildSeed(seedRowIds(), SEED_RUN_AT).playbook.find(
	(p) => p.missionType === "template-booking",
);

let idem = 0;
/** A fresh Idempotency-Key under the call's namespace. */
const key = (h: ApiHarness) =>
	`${h.ns}-0000-4000-b000-${(++idem).toString(16).padStart(12, "0")}`;

async function ok<T>(
	res: Response,
	status: number,
	schema: { parse: (x: unknown) => { data: T } },
): Promise<T> {
	expect(res.status, await res.clone().text()).toBe(status);
	return schema.parse(await res.json()).data;
}

describe.skipIf(!process.env.DATABASE_URL)(
	"the first mission, end to end",
	{ timeout: 120_000 },
	() => {
		it("runs intake to gate over the API, on a real room", async () => {
			// The template clone and the client's clone, both at the fixture's
			// commit: the client's code came from the template.
			const templateClone = path.join(sources, "templates", "template-booking");
			expect(await buildDevTemplateBooking(templateClone)).toBe(
				DEV_BOOKING_SHA,
			);
			expect(await buildDevTemplateBooking(clientClone)).toBe(DEV_BOOKING_SHA);
			const harness = new FakeHarness();
			const rooms = worktreeRooms(path.join(base, "rooms"));
			// GitHub's answer for meridian-co/app is that clone's commit.
			const snapshot = snapshotOfCommit(clientClone, DEV_BOOKING_SHA);
			expect(snapshot.entries.map((e) => e.path).sort()).toEqual(
				gitIn(clientClone, "ls-tree", "-r", "--name-only", DEV_BOOKING_SHA)
					.split("\n")
					.sort(),
			);
			const repos = fixtureRepos({ "meridian-co/app": snapshot });

			await withApi(
				async (h) => {
					await h.signIn();
					const post = (p: string, body: unknown = {}, headers = {}) =>
						h.call(p, { method: "POST", body, headers });

					// 1-2. Client and engagement.
					const clientId = (
						await ok(
							await post("/api/clients", { name: "Meridian" }),
							201,
							successEnvelope(clientSchema),
						)
					).id;
					const engagementId = (
						await ok(
							await post("/api/engagements", { clientId, name: "Booking" }),
							201,
							successEnvelope(engagementSchema),
						)
					).id;

					// 3. Intake: draft, repo read, propose, approve with a ceiling.
					const intake = successEnvelope(intakeSchema);
					const intakeId = (
						await ok(
							await post("/api/intakes", {
								engagementId,
								sourceMd: "Call notes: the shop wants online booking.",
								proposedBrief: BRIEF,
							}),
							201,
							intake,
						)
					).id;
					const connectionId = (
						await ok(
							await post("/api/connections", {
								engagementId,
								label: "Meridian",
								scopeType: "owner",
								scopeValue: "meridian-co",
								credentialRef: "MERIDIAN_GITHUB_TOKEN",
							}),
							201,
							successEnvelope(connectionSchema),
						)
					).id;
					const read = await ok(
						await post(`/api/intakes/${intakeId}/read-repo`, {
							connectionId,
							repoUrl: REPO,
						}),
						200,
						intake,
					);
					expect(read.derivedCut).not.toBeNull();
					expect(read.repoUrl).toBe(REPO);
					expect(read.repoCommitSha).toBe(DEV_BOOKING_SHA);
					await ok(await post(`/api/intakes/${intakeId}/propose`), 200, intake);
					const approved = await ok(
						await post(`/api/intakes/${intakeId}/approve`, {
							missionType: "template-booking",
							repoUrl: REPO,
							spendCeilingUsd: 5,
						}),
						200,
						intake,
					);
					expect(approved.status).toBe("approved");
					const missionId = approved.missionId as string;
					expect(missionId.startsWith(h.ns)).toBe(true);

					// 4. The plan, pinned to the dev fixture's commit: the record of
					// which template version the client's code came from.
					const plan = await ok(
						await h.call(`/api/missions/${missionId}/plan`, {
							method: "PUT",
							body: {
								brief: PLAN,
								templateRef: "template-booking",
								templateVersion: DEV_BOOKING_SHA,
							},
						}),
						200,
						successEnvelope(missionPlanSchema),
					);
					expect(plan.check).toEqual({ passed: true, issues: [] });

					// 5. The roster. GAP: no route creates an agent template, so
					// this one is inserted; its identity is generated by the route.
					const templateId = seedIds(h.ns).next();
					await h.tx.insert(agentTemplate).values({
						id: templateId,
						slug: `atlas-${h.ns}`,
						name: "Atlas",
						title: "Scheduling builder",
						kind: "feature",
						roles: ["domain", "api-surface"],
						waveDefaults: ["A"],
						writablePaths: ["src/features/scheduling/**"],
						version: 1,
						...stamp(clock),
					});
					const regen = await post(
						`/api/agent-templates/${templateId}/identity/regenerate`,
					);
					expect(regen.status, await regen.clone().text()).toBe(201);
					// The playbook and its default preset, through their routes.
					const presetRes = await post("/api/presets", {
						name: `Booking ${h.ns}`,
						cut: "vertical",
						agents: [
							{
								agentTemplateId: templateId,
								waves: ["A"],
								territory: "scheduling",
								writablePaths: null,
								estimatedTokens: 20_000,
							},
						],
					});
					expect(presetRes.status, await presetRes.clone().text()).toBe(201);
					const presetId = (
						(await presetRes.json()) as { data: { id: string } }
					).data.id;
					const book = await post("/api/playbooks", {
						missionType: "template-booking",
						name: booking?.name,
						wavesApplicable: booking?.wavesApplicable,
						gates: booking?.gates,
						deliverable: booking?.deliverable,
						requiredFields: booking?.requiredFields,
						defaultPresetId: presetId,
					});
					expect(book.status, await book.clone().text()).toBe(201);
					const applied = await post(
						`/api/missions/${missionId}/roster/apply-preset`,
						{ presetId },
					);
					expect(applied.status, await applied.clone().text()).toBe(200);
					const roster = await h.call(`/api/missions/${missionId}/roster`);
					const entries = (
						(await roster.json()) as { data: Array<{ id: string }> }
					).data;
					expect(entries).toHaveLength(1);
					const entryId = entries[0]?.id as string;

					// 6. Readiness, then start.
					const ready = await h.call(`/api/missions/${missionId}/readiness`);
					expect(ready.status, await ready.clone().text()).toBe(200);
					const readiness = (
						(await ready.json()) as {
							data: {
								ready: boolean;
								blockers: unknown[];
								warnings: unknown[];
							};
						}
					).data;
					expect(readiness).toMatchObject({
						ready: true,
						blockers: [],
						warnings: [],
					});
					const started = await post(`/api/missions/${missionId}/start`);
					expect(started.status, await started.clone().text()).toBe(200);

					// 7. One dispatch, in a worktree room on the commit the intake
					// read, made from the client's clone.
					const one = successEnvelope(dispatchWire);
					const queued = await ok(
						await post(
							`/api/missions/${missionId}/dispatches`,
							{
								rosterEntryId: entryId,
								briefRef: { moduleId: "M1", requirementIds: ["R1"] },
							},
							{ "idempotency-key": key(h) },
						),
						201,
						one,
					);
					const running = await ok(
						await post(`/api/dispatches/${queued.id}/start`),
						200,
						one,
					);
					expect(running.status).toBe("running");
					const room = await rooms.get(queued.id);
					expect(room?.commit).toBe(read.repoCommitSha);
					expect(room?.repoPath).toBe(clientClone);
					expect(gitIn(room?.root ?? "", "rev-parse", "HEAD")).toBe(
						read.repoCommitSha,
					);

					// 8. The agent: its own dispatch, one write inside its mount
					// through the harness's file tool, then its report. The write
					// goes through the tool, not HTTP: agents have no file route.
					const token = harness.tokenFor(queued.id) as string;
					const asAgent = (p: string, init: RequestInit = {}) =>
						h.app.request(p, {
							...init,
							headers: {
								...bearer(token),
								"content-type": "application/json",
								...(init.headers as Record<string, string>),
							},
						});
					const own = await asAgent("/api/agent/dispatch");
					expect(own.status, await own.clone().text()).toBe(200);
					await writeTool(
						room as NonNullable<typeof room>,
						SLOTS,
						"export const slots = (taken: number) => 5 - taken;\n",
					);
					const report = await asAgent("/api/agent/report", {
						method: "POST",
						headers: { "idempotency-key": key(h) },
						body: JSON.stringify({
							status: "complete",
							artifactsRead: [],
							blockers: [],
							rereads: 0,
						}),
					});
					expect(report.status, await report.clone().text()).toBe(201);
					const closed = await ok(
						await h.call(`/api/dispatches/${queued.id}`),
						200,
						one,
					);
					expect(closed.status).toBe("complete");

					// 9. The gate on the integration commit.
					const run = await ok(
						await post(`/api/missions/${missionId}/gate`),
						201,
						successEnvelope(gateRunSchema),
					);
					expect(run.baseSha).toBe(read.repoCommitSha);
					expect(run.commitSha).not.toBe(DEV_BOOKING_SHA);
					expect(run.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
					expect(run.gates.map((g) => [g.gate, g.policy])).toEqual([
						["qa", "mandatory"],
						["acceptance", "mandatory"],
					]);
					const spec = run.reasons.filter((r) => r.source === "spec-check");
					expect(spec.length).toBeGreaterThan(0);
					expect(spec.every((r) => r.gate === "qa")).toBe(true);
					const fileCheck = run.reasons.find((r) => r.source === "file_exists");
					expect(fileCheck).toMatchObject({
						gate: "acceptance",
						effect: "pass",
					});
					// What each listed gate saw. The test check needs a runner, so it
					// is a degraded warn on a mandatory gate, and the mission still
					// passes with no test run: the "not fully checked" gap.
					expect(
						run.gates.map((g) => ({
							gate: g.gate,
							verdict: g.verdict,
							reasons: g.reasons.map((r) => [
								r.source,
								r.rule,
								r.effect,
								r.degraded,
							]),
						})),
					).toEqual([
						{
							gate: "qa",
							verdict: "pass",
							reasons: [
								["checkpoint:protected-paths", "passed", "pass", false],
								["checkpoint:test-glob", "passed", "pass", false],
								["spec-check", "passed", "pass", false],
							],
						},
						{
							gate: "acceptance",
							verdict: "warn",
							reasons: [
								["runner", "degraded_not_run", "warn", true],
								["file_exists", "passed", "pass", false],
							],
						},
					]);
					expect(run.verdict).toBe("pass");
					// The pass ran no test, so it must not read as verified (J,
					// 2026-10-21): a warn gate with no evidence and a degraded check
					// both leave the run not fully checked.
					expect(run).toMatchObject({
						assurance: "not_fully_checked",
						decideVersion: 2,
						receiptVersion: 2,
					});

					// 10. The mission's activity, oldest first.
					const log = await h.call(
						`/api/activity?missionId=${missionId}&limit=100`,
					);
					const rows = activityListEnvelope.parse(await log.json()).data;
					expect(rows.map((r) => r.action).reverse()).toEqual([
						"mission.created",
						"intake.approved",
						"mission.plan_updated",
						"roster.entry_added",
						"roster.preset_applied",
						"mission.status_changed",
						"dispatch.created",
						"dispatch.started",
						"completion_report.filed",
						"dispatch.closed",
						"mission.gate_run",
					]);
				},
				{
					harness,
					rooms,
					roomSources: localSources(sources),
					repos,
				},
			);
		});
	},
);
